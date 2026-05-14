from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
import httpx
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.models import (
    CompetitorAnalysisSnapshot,
    CopyVersion,
    DraftImage,
    Entry,
    PublishAttempt,
    Template,
    User,
)
from app.ollama_copy import build_copy_system_prompt, call_ollama_chat, parse_generated_title_body
from app.schemas import (
    CompetitorAnalysisHistoryOut,
    CopyGenerateIn,
    CopyVersionOut,
    CopyVersionPatchIn,
    DraftImageCreateIn,
    DraftImageOut,
    DraftImagePatchIn,
    EntryDetailOut,
    EntryPatchIn,
    EntrySummaryOut,
    ImageReorderIn,
    PublishAttemptIn,
    PublishAttemptOut,
    XhsTopNoteIn,
)
from app.snapshot_refs import draft_image_referenced_in_composed_snapshots

router = APIRouter(prefix="/entries", tags=["entries"])

ALLOWED_PUBLISH_OUTCOMES = frozenset(
    {
        "extension_success",
        "clipboard_fallback",
        "extension_error_only",
    }
)

ALLOWED_IMAGE_TYPES = frozenset({"image/jpeg", "image/png", "image/webp", "image/gif"})
_IMAGE_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024


def _draft_image_count(db: Session, entry_id: UUID) -> int:
    n = db.scalar(select(func.count()).select_from(DraftImage).where(DraftImage.entry_id == entry_id))
    return int(n or 0)


def _ensure_pool_has_room(db: Session, entry_id: UUID, *, adding: int = 1) -> None:
    cap = settings.max_draft_images_per_entry
    if _draft_image_count(db, entry_id) + adding > cap:
        raise HTTPException(status_code=400, detail="draft_image_pool_full")


def _touch_entry(entry: Entry) -> None:
    entry.updated_at = datetime.now(timezone.utc)


def _demote_primary_copy_versions(db: Session, entry_id: UUID) -> None:
    # 仅降级当前主版本；避免 ORM 批量 flush 时更新顺序不确定触发“同 entry 只能一个 is_primary=true”的唯一约束
    db.execute(
        update(CopyVersion)
        .where(CopyVersion.entry_id == entry_id, CopyVersion.is_primary.is_(True))
        .values(is_primary=False)
    )


def _apply_primary_version_to_entry(db: Session, entry: Entry, version: CopyVersion) -> None:
    _demote_primary_copy_versions(db, entry.id)
    # 先 flush 降级，再提升新主版本，确保不会瞬间出现两个 is_primary=true
    db.flush()
    version.is_primary = True
    entry.title = version.title or ""
    entry.body = version.body or ""
    _touch_entry(entry)


def _sync_primary_copy_version_from_entry(db: Session, entry: Entry) -> None:
    """PRD §5.2/§5.4：工作台与「主文案版本」同源；条目 title/body 与 is_primary 文案版本对齐。"""
    primary = db.scalar(
        select(CopyVersion).where(
            CopyVersion.entry_id == entry.id,
            CopyVersion.is_primary.is_(True),
        )
    )
    if primary is not None:
        primary.title = entry.title or ""
        primary.body = entry.body or ""
        return
    versions = list(
        db.scalars(
            select(CopyVersion)
            .where(CopyVersion.entry_id == entry.id)
            .order_by(CopyVersion.created_at.desc())
        ).all()
    )
    if versions:
        chosen = versions[0]
        for v in versions:
            v.is_primary = v.id == chosen.id
        chosen.title = entry.title or ""
        chosen.body = entry.body or ""
        return
    db.add(
        CopyVersion(
            entry_id=entry.id,
            title=entry.title or "",
            body=entry.body or "",
            source="manual",
            is_primary=True,
        )
    )


@router.get("", response_model=list[EntrySummaryOut])
def list_entries(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Entry]:
    rows = db.scalars(select(Entry).where(Entry.owner_id == user.id).order_by(Entry.updated_at.desc())).all()
    return list(rows)


def _snapshot_to_history_out(row: CompetitorAnalysisSnapshot) -> CompetitorAnalysisHistoryOut:
    raw = row.top10_items or []
    top10: list[XhsTopNoteIn] = []
    for x in raw:
        if isinstance(x, dict):
            try:
                top10.append(XhsTopNoteIn.model_validate(x))
            except Exception:
                continue
    return CompetitorAnalysisHistoryOut(
        id=row.id,
        entry_id=row.entry_id,
        source_keyword=row.source_keyword or "",
        top10=top10,
        analysis_markdown=row.analysis_markdown or "",
        generated_title=row.generated_title or "",
        generated_body=row.generated_body or "",
        created_at=row.created_at,
    )


@router.get("/{entry_id}/competitor-analyses", response_model=list[CompetitorAnalysisHistoryOut])
def list_competitor_analyses(
    entry_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    limit: int = Query(default=30, ge=1, le=50),
) -> list[CompetitorAnalysisHistoryOut]:
    ok = db.scalar(select(Entry.id).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if ok is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    rows = db.scalars(
        select(CompetitorAnalysisSnapshot)
        .where(CompetitorAnalysisSnapshot.entry_id == entry_id)
        .order_by(CompetitorAnalysisSnapshot.created_at.desc())
        .limit(limit)
    ).all()
    return [_snapshot_to_history_out(r) for r in rows]


@router.get("/{entry_id}", response_model=EntryDetailOut)
def get_entry(
    entry_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Entry:
    entry = db.scalar(
        select(Entry)
        .options(selectinload(Entry.images))
        .where(Entry.id == entry_id, Entry.owner_id == user.id)
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    entry.images.sort(key=lambda i: i.sort_order)
    return entry


@router.get("/{entry_id}/copy-versions", response_model=list[CopyVersionOut])
def list_copy_versions(
    entry_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[CopyVersion]:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    rows = db.scalars(
        select(CopyVersion)
        .where(CopyVersion.entry_id == entry_id)
        .order_by(CopyVersion.created_at.desc())
    ).all()
    return list(rows)


@router.post("/{entry_id}/copy-versions/generate", response_model=CopyVersionOut, status_code=status.HTTP_201_CREATED)
def generate_copy_version(
    entry_id: UUID,
    payload: CopyGenerateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CopyVersion:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    if entry.selected_template_id is None:
        raise HTTPException(status_code=400, detail="no_template_selected")
    tpl = db.scalar(
        select(Template).where(
            Template.id == entry.selected_template_id,
            Template.owner_id == user.id,
        )
    )
    if tpl is None:
        raise HTTPException(status_code=400, detail="template_not_found")
    if not tpl.enabled:
        raise HTTPException(status_code=400, detail="template_disabled")

    url_note = (payload.competitor_url or "").strip()
    paste = (payload.competitor_paste or "").strip()
    meta = tpl.copy_metadata or {}
    visual = ""
    if isinstance(meta, dict):
        v = meta.get("visual_style_hint")
        if isinstance(v, str) and v.strip():
            visual = v.strip()

    user_blocks = [
        f"【文案模版名称】{tpl.name}",
        f"【适用场景】{tpl.scenario or '（无）'}",
        f"【段落结构说明】{tpl.structure_description or '（无）'}",
    ]
    if visual:
        user_blocks.append(f"【模版视觉风格提示（供语气参考，正文勿写画图指令）】{visual}")
    if isinstance(meta, dict) and meta:
        rest_meta: dict[str, object] = {}
        for k, v in meta.items():
            if k == "visual_style_hint" and visual:
                continue
            rest_meta[str(k)] = v
        if rest_meta:
            try:
                meta_json = json.dumps(rest_meta, ensure_ascii=False)
                if len(meta_json) > 2800:
                    meta_json = meta_json[:2800] + "…"
                user_blocks.append("【模版元数据（JSON，生成时须遵守）】\n" + meta_json)
            except (TypeError, ValueError):
                pass
    if url_note:
        user_blocks.append(f"【竞品笔记链接（仅供参考，勿复述链接）】{url_note}")
    if paste:
        user_blocks.append("【竞品文案粘贴（须改写脱敏，勿长段照搬）】\n" + paste[:12000])
        if "【对标草稿" in paste:
            user_blocks.append(
                "【对标草稿用途】上一条含「对标草稿」为竞品参考工具产出；须与上文模版要求一并满足：再创作、显著改表述，勿逐句复述。"
            )
    user_blocks.append(
        "【输出】请综合以上模版字段（名称、场景、段落结构及元数据）"
        + ("与竞品参考" if (url_note or paste) else "")
        + "，生成一篇新的小红书笔记 JSON：字段 title、body。"
    )
    user_prompt = "\n\n".join(user_blocks)

    try:
        raw = call_ollama_chat(system=build_copy_system_prompt(), user=user_prompt)
        title, body = parse_generated_title_body(raw)
    except httpx.HTTPError:
        raise HTTPException(
            status_code=502,
            detail="ollama_unreachable",
        ) from None
    except (ValueError, KeyError, TypeError):
        raise HTTPException(
            status_code=502,
            detail="ollama_bad_response",
        ) from None

    cv = CopyVersion(
        entry_id=entry_id,
        title=title,
        body=body,
        source="generated",
        is_primary=False,
    )
    db.add(cv)
    db.flush()
    _apply_primary_version_to_entry(db, entry, cv)
    db.commit()
    db.refresh(cv)
    return cv


@router.patch("/{entry_id}/copy-versions/{copy_version_id}", response_model=CopyVersionOut)
def patch_copy_version(
    entry_id: UUID,
    copy_version_id: UUID,
    payload: CopyVersionPatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CopyVersion:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    cv = db.scalar(
        select(CopyVersion).where(
            CopyVersion.id == copy_version_id,
            CopyVersion.entry_id == entry_id,
        )
    )
    if cv is None:
        raise HTTPException(status_code=404, detail="copy_version_not_found")
    if payload.title is not None:
        cv.title = payload.title[:500] if payload.title else ""
    if payload.body is not None:
        cv.body = payload.body
    if cv.is_primary:
        entry.title = cv.title or ""
        entry.body = cv.body or ""
        _touch_entry(entry)
    db.commit()
    db.refresh(cv)
    return cv


@router.post(
    "/{entry_id}/copy-versions/{copy_version_id}/make-primary",
    response_model=CopyVersionOut,
)
def make_copy_version_primary(
    entry_id: UUID,
    copy_version_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CopyVersion:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    cv = db.scalar(
        select(CopyVersion).where(
            CopyVersion.id == copy_version_id,
            CopyVersion.entry_id == entry_id,
        )
    )
    if cv is None:
        raise HTTPException(status_code=404, detail="copy_version_not_found")
    _apply_primary_version_to_entry(db, entry, cv)
    db.commit()
    db.refresh(cv)
    return cv


@router.patch("/{entry_id}", response_model=EntryDetailOut)
def patch_entry(
    entry_id: UUID,
    body: EntryPatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Entry:
    entry = db.scalar(
        select(Entry).options(selectinload(Entry.images)).where(Entry.id == entry_id, Entry.owner_id == user.id)
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    if body.title is not None:
        entry.title = body.title
    if body.body is not None:
        entry.body = body.body
    if body.topics is not None:
        entry.topics = list(body.topics)
    if "selected_template_id" in body.model_fields_set:
        tid = body.selected_template_id
        if tid is not None:
            tpl = db.scalar(
                select(Template).where(Template.id == tid, Template.owner_id == user.id),
            )
            if tpl is None:
                raise HTTPException(status_code=400, detail="template_not_found")
        entry.selected_template_id = tid
    _touch_entry(entry)
    if body.title is not None or body.body is not None:
        _sync_primary_copy_version_from_entry(db, entry)
    db.commit()
    db.refresh(entry)
    entry.images.sort(key=lambda i: i.sort_order)
    return entry


@router.post("/{entry_id}/images", response_model=DraftImageOut, status_code=status.HTTP_201_CREATED)
def add_image(
    entry_id: UUID,
    payload: DraftImageCreateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DraftImage:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    _ensure_pool_has_room(db, entry_id, adding=1)
    if payload.source_copy_version_id is not None:
        cv_ok = db.scalar(
            select(CopyVersion).where(
                CopyVersion.id == payload.source_copy_version_id,
                CopyVersion.entry_id == entry_id,
            )
        )
        if cv_ok is None:
            raise HTTPException(status_code=400, detail="source_copy_version_mismatch")
    max_ord = db.scalar(select(func.max(DraftImage.sort_order)).where(DraftImage.entry_id == entry_id))
    next_ord = (max_ord + 1) if max_ord is not None else 0
    sort_order = payload.sort_order if payload.sort_order is not None else next_ord
    if payload.is_cover:
        for img in db.scalars(select(DraftImage).where(DraftImage.entry_id == entry_id)):
            img.is_cover = False
    img = DraftImage(
        entry_id=entry_id,
        sort_order=sort_order,
        public_url=payload.public_url,
        is_cover=payload.is_cover,
        include_in_publish=payload.include_in_publish,
        source_copy_version_id=payload.source_copy_version_id,
    )
    db.add(img)
    _touch_entry(entry)
    db.commit()
    db.refresh(img)
    return img


@router.post("/{entry_id}/images/upload", response_model=DraftImageOut, status_code=status.HTTP_201_CREATED)
async def upload_image_file(
    entry_id: UUID,
    file: UploadFile = File(...),
    source_copy_version_id: Optional[UUID] = Form(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DraftImage:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    _ensure_pool_has_room(db, entry_id, adding=1)
    ct = (file.content_type or "").split(";")[0].strip().lower()
    if ct not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="invalid_image_mime")
    raw = await file.read()
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="file_too_large")
    ext = _IMAGE_EXT.get(ct, ".img")
    fname = f"{entry_id}_{uuid.uuid4().hex}{ext}"
    dest: Path = settings.upload_path / fname
    dest.write_bytes(raw)
    public_url = f"{settings.public_base_url.rstrip('/')}/api/uploads/{fname}"

    max_ord = db.scalar(select(func.max(DraftImage.sort_order)).where(DraftImage.entry_id == entry_id))
    next_ord = (max_ord + 1) if max_ord is not None else 0
    cv_id = source_copy_version_id
    if cv_id is not None:
        cv_ok = db.scalar(
            select(CopyVersion).where(
                CopyVersion.id == cv_id,
                CopyVersion.entry_id == entry_id,
            )
        )
        if cv_ok is None:
            raise HTTPException(status_code=400, detail="source_copy_version_mismatch")
    else:
        cv_id = db.scalar(
            select(CopyVersion.id).where(
                CopyVersion.entry_id == entry_id,
                CopyVersion.is_primary.is_(True),
            )
        )
    img = DraftImage(
        entry_id=entry_id,
        sort_order=next_ord,
        public_url=public_url,
        is_cover=False,
        include_in_publish=True,
        source_copy_version_id=cv_id,
    )
    db.add(img)
    _touch_entry(entry)
    db.commit()
    db.refresh(img)
    return img


@router.patch("/{entry_id}/images/{image_id}", response_model=DraftImageOut)
def patch_image(
    entry_id: UUID,
    image_id: UUID,
    payload: DraftImagePatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DraftImage:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    img = db.scalar(select(DraftImage).where(DraftImage.id == image_id, DraftImage.entry_id == entry_id))
    if img is None:
        raise HTTPException(status_code=404, detail="Image not found")
    if payload.sort_order is not None:
        img.sort_order = payload.sort_order
    if payload.include_in_publish is not None:
        img.include_in_publish = payload.include_in_publish
    if payload.is_cover is not None:
        if payload.is_cover:
            for other in db.scalars(select(DraftImage).where(DraftImage.entry_id == entry_id)):
                other.is_cover = other.id == image_id
        else:
            img.is_cover = False
    _touch_entry(entry)
    db.commit()
    db.refresh(img)
    return img


@router.delete("/{entry_id}/images/{image_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_image(
    entry_id: UUID,
    image_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    img = db.scalar(select(DraftImage).where(DraftImage.id == image_id, DraftImage.entry_id == entry_id))
    if img is None:
        raise HTTPException(status_code=404, detail="Image not found")
    if draft_image_referenced_in_composed_snapshots(db, entry_id=entry_id, image_id=image_id):
        raise HTTPException(
            status_code=409,
            detail="image_locked_by_composed_snapshot",
        )
    if "/api/uploads/" in img.public_url:
        name = img.public_url.rsplit("/", maxsplit=1)[-1]
        try:
            (settings.upload_path / name).unlink(missing_ok=True)
        except OSError:
            pass
    db.delete(img)
    _touch_entry(entry)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{entry_id}/images/reorder", response_model=EntryDetailOut)
def reorder_images(
    entry_id: UUID,
    payload: ImageReorderIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Entry:
    entry = db.scalar(
        select(Entry).options(selectinload(Entry.images)).where(Entry.id == entry_id, Entry.owner_id == user.id)
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    images = {i.id: i for i in entry.images}
    for idx, uid in enumerate(payload.ids):
        img = images.get(uid)
        if img is None:
            raise HTTPException(status_code=400, detail=f"Unknown image id: {uid}")
        img.sort_order = idx
    _touch_entry(entry)
    db.commit()
    db.refresh(entry)
    entry.images.sort(key=lambda i: i.sort_order)
    return entry


@router.post("/{entry_id}/publish-attempts", response_model=PublishAttemptOut)
def create_publish_attempt(
    entry_id: UUID,
    payload: PublishAttemptIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PublishAttempt:
    if payload.outcome not in ALLOWED_PUBLISH_OUTCOMES:
        raise HTTPException(status_code=400, detail="invalid_publish_attempt_outcome")
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    row = PublishAttempt(
        entry_id=entry_id,
        outcome=payload.outcome,
        extension_error=payload.extension_error,
        bridge_payload=payload.bridge_payload,
        client_hints=payload.client_hints,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/{entry_id}/publish-attempts", response_model=list[PublishAttemptOut])
def list_publish_attempts(
    entry_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    limit: int = 50,
) -> list[PublishAttempt]:
    if limit < 1:
        limit = 1
    if limit > 100:
        limit = 100
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    rows = list(
        db.scalars(
            select(PublishAttempt)
            .where(PublishAttempt.entry_id == entry_id)
            .order_by(PublishAttempt.created_at.desc())
            .limit(limit)
        ).all()
    )
    return rows
