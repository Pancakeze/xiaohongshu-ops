from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.competitor_scrape import ScrapedPage, score_page, scrape_url
from app.database import get_db
from app.deps import get_current_user
from app.models import CompetitorAnalysisSnapshot, Entry
from app.ollama_copy import call_ollama_chat, parse_competitor_analysis_output
from app.xhs_k12_compliance import XHS_K12_COMPLIANCE_USER_REMINDER, append_k12_compliance_to_system_prompt
from app.schemas import (
    CompetitorAnalyzeIn,
    CompetitorAnalyzeOut,
    CompetitorAnalyzeXhsIn,
    CompetitorAnalyzeXhsOut,
    CompetitorPageOut,
    XhsTopNoteIn,
)

import httpx

router = APIRouter(prefix="/competitors", tags=["competitors"])


def _page_to_out(p: ScrapedPage) -> CompetitorPageOut:
    return CompetitorPageOut(
        url=p.url,
        ok=p.ok,
        error=p.error,
        title=p.title,
        description=p.description,
        text_excerpt=p.text_excerpt,
        text_len=p.text_len,
    )


def _build_competitor_system_prompt() -> str:
    return append_k12_compliance_to_system_prompt(
        "你是小红书增长与内容策略分析师。"
        "你会基于给定的竞品页面摘要，提炼「top10 竞品特征/套路」并产出可执行的写作建议。"
        "最后你还要为用户生成一篇新的小红书笔记（标题+正文），要求明显不同于竞品措辞。"
        "输出必须是一个 JSON 对象，不要 markdown 代码围栏，不要其它说明文字。"
        'JSON 格式：{"analysis_markdown":"...","generated":{"title":"...","body":"..."}}。'
        "analysis_markdown 用 markdown 组织要点；generated.title <= 80 字；generated.body 可换行，口语化。"
        "如果竞品摘要不足，请坦诚说明不确定性，但仍给出可用文案。"
    )


def _build_xhs_system_prompt() -> str:
    return append_k12_compliance_to_system_prompt(
        "你是小红书增长与内容策略分析师。"
        "你会基于「小红书站内搜索 Top10 笔记卡片信息」（标题/摘要/点赞数参考）做竞品套路总结，"
        "再生成一篇对标的新笔记（标题+正文）。"
        "注意：竞品内容仅作结构参考，措辞必须明显不同，避免照搬。"
        "输出必须是一个 JSON 对象，不要 markdown 代码围栏，不要其它说明文字。"
        'JSON 格式：{"analysis_markdown":"...","generated":{"title":"...","body":"..."}}。'
        "analysis_markdown 用 markdown 组织要点；generated.title <= 80 字；generated.body 可换行，口语化。"
        "如果卡片信息不足，请在分析里标注不确定性，并给出补充抓取建议。"
    )


def _build_xhs_user_prompt(payload: CompetitorAnalyzeXhsIn, top10: list[XhsTopNoteIn]) -> str:
    blocks: list[str] = []
    blocks.append("【任务】基于小红书站内搜索结果 Top10（卡片信息） -> 做竞品分析 -> 生成一篇新文案。")
    blocks.append(f"【关键词】{payload.keyword.strip()[:200]}")
    if payload.goal and payload.goal.strip():
        blocks.append(f"【对标目标】{payload.goal.strip()[:2000]}")
    if payload.audience and payload.audience.strip():
        blocks.append(f"【目标人群】{payload.audience.strip()[:800]}")
    if payload.product and payload.product.strip():
        blocks.append(f"【我的产品/服务】{payload.product.strip()[:2000]}")
    blocks.append("【Top10 卡片信息】")
    for idx, it in enumerate(top10, start=1):
        blocks.append(
            "\n".join(
                [
                    f"{idx}. 标题：{(it.title or '').strip()[:200]}",
                    f"链接：{(it.url or '').strip()[:800]}",
                    f"作者：{(it.author or '').strip()[:120] or '（未知）'}",
                    f"摘要：{(it.excerpt or '').strip()[:400] or '（无）'}",
                    f"点赞参考：{(it.like_text or '').strip()[:50] or '（无）'}",
                ]
            )
        )
    blocks.append(
        "请输出 JSON：analysis_markdown 里给出"
        "1) 竞品 top10 结构套路（开头钩子、痛点、证据、步骤、对比、CTA、话题词）"
        "2) 你建议的差异化切入点（至少 5 条）"
        "3) 可直接抄作业的标题公式（至少 10 条）"
        "并生成 generated.title + generated.body。"
    )
    blocks.append(XHS_K12_COMPLIANCE_USER_REMINDER)
    return "\n\n".join(blocks)


def _build_user_prompt(payload: CompetitorAnalyzeIn, pages: list[CompetitorPageOut]) -> str:
    blocks: list[str] = []
    blocks.append("【任务】抓取竞品页面摘要 -> 做 top10 分析 -> 生成一篇新文案。")
    if payload.goal and payload.goal.strip():
        blocks.append(f"【对标目标】{payload.goal.strip()[:2000]}")
    if payload.audience and payload.audience.strip():
        blocks.append(f"【目标人群】{payload.audience.strip()[:800]}")
    if payload.product and payload.product.strip():
        blocks.append(f"【我的产品/服务】{payload.product.strip()[:2000]}")
    blocks.append("【竞品样本（已抓取摘要）】")
    for idx, p in enumerate(pages, start=1):
        if not p.ok:
            blocks.append(f"{idx}. URL={p.url}\n抓取失败：{p.error or 'unknown'}")
            continue
        blocks.append(
            "\n".join(
                [
                    f"{idx}. URL={p.url}",
                    f"标题：{(p.title or '').strip()[:300] or '（无）'}",
                    f"描述：{(p.description or '').strip()[:600] or '（无）'}",
                    f"正文摘录：{(p.text_excerpt or '').strip()[:900] or '（无）'}",
                    f"文本长度：{p.text_len}",
                ]
            )
        )
    blocks.append(
        "请输出 JSON：analysis_markdown 里给出"
        "1) 竞品 top10 结构套路（含开头钩子、痛点、证据、CTA、标签）"
        "2) 你建议的差异化切入点（至少 5 条）"
        "3) 可直接抄作业的标题公式（至少 10 条）"
        "并生成 generated.title + generated.body。"
    )
    blocks.append(XHS_K12_COMPLIANCE_USER_REMINDER)
    return "\n\n".join(blocks)


def _ollama_chat_json_preferred(*, system: str, user: str) -> str:
    """优先请求 JSON mode；旧版 Ollama 若因未知字段 400，则回退为普通 chat。"""
    try:
        return call_ollama_chat(system=system, user=user, response_format="json")
    except httpx.HTTPStatusError as e:
        if e.response is not None and e.response.status_code == 400:
            return call_ollama_chat(system=system, user=user)
        raise


@router.post("/analyze", response_model=CompetitorAnalyzeOut)
def analyze_competitors(
    payload: CompetitorAnalyzeIn,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
) -> CompetitorAnalyzeOut:
    _ = db, user  # 保持与其它路由一致：鉴权即可，本端点不写 DB

    if not payload.urls:
        raise HTTPException(status_code=400, detail="missing_urls")

    scraped: list[ScrapedPage] = [scrape_url(u, timeout_seconds=15.0) for u in payload.urls]
    fetched = [_page_to_out(p) for p in scraped]

    ok_pages = [p for p in fetched if p.ok]
    ranked = sorted(ok_pages, key=lambda p: score_page(ScrapedPage(**p.model_dump())), reverse=True)
    top10 = ranked[:10]

    user_prompt = _build_user_prompt(payload, top10 if top10 else fetched[:10])
    try:
        raw = _ollama_chat_json_preferred(system=_build_competitor_system_prompt(), user=user_prompt)
        analysis_md, title, body = parse_competitor_analysis_output(raw)
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="ollama_unreachable") from None
    except Exception:
        raise HTTPException(status_code=502, detail="ollama_bad_response") from None

    return CompetitorAnalyzeOut(
        fetched=fetched,
        top10=top10,
        analysis_markdown=analysis_md.strip(),
        generated_title=title.strip()[:500],
        generated_body=body.strip(),
    )


@router.post("/analyze-xhs", response_model=CompetitorAnalyzeXhsOut)
def analyze_competitors_xhs(
    payload: CompetitorAnalyzeXhsIn,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
) -> CompetitorAnalyzeXhsOut:
    _ = db, user
    keyword = (payload.keyword or "").strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="missing_keyword")
    items = list(payload.items or [])[:10]
    if not items:
        raise HTTPException(status_code=400, detail="missing_items")

    user_prompt = _build_xhs_user_prompt(payload, items)
    try:
        raw = _ollama_chat_json_preferred(system=_build_xhs_system_prompt(), user=user_prompt)
        analysis_md, title, body = parse_competitor_analysis_output(raw)
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="ollama_unreachable") from None
    except Exception:
        raise HTTPException(status_code=502, detail="ollama_bad_response") from None

    saved_id = None
    if payload.entry_id is not None:
        entry = db.scalar(select(Entry).where(Entry.id == payload.entry_id, Entry.owner_id == user.id))
        if entry is not None:
            snap = CompetitorAnalysisSnapshot(
                owner_id=user.id,
                entry_id=entry.id,
                source_keyword=keyword[:8000],
                top10_items=[i.model_dump() for i in items],
                analysis_markdown=analysis_md.strip(),
                generated_title=title.strip()[:500],
                generated_body=body.strip(),
            )
            db.add(snap)
            db.commit()
            db.refresh(snap)
            saved_id = snap.id

    return CompetitorAnalyzeXhsOut(
        keyword=keyword,
        top10=items,
        analysis_markdown=analysis_md.strip(),
        generated_title=title.strip()[:500],
        generated_body=body.strip(),
        saved_id=saved_id,
    )

