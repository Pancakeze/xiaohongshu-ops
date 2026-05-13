from __future__ import annotations

import json
import re
from typing import Any

import httpx

from app.config import settings


def _strip_markdown_json_fence(text: str) -> str:
    t = (text or "").strip()
    if "```" not in t:
        return t
    start = t.find("```")
    if start < 0:
        return t
    # 跳过首行 ``` 或 ```json
    rest = t[start + 3 :].lstrip()
    if rest.lower().startswith("json"):
        rest = rest[4:].lstrip()
    if rest.startswith("\n"):
        rest = rest[1:]
    end = rest.rfind("```")
    if end >= 0:
        rest = rest[:end].strip()
    return rest.strip()


def _first_balanced_json_object(text: str) -> str | None:
    """从任意前缀文本中切出第一个花括号配平的 JSON 子串（避免 greedy \\{...\\} 被 markdown 内大括号污染）。"""
    s = text or ""
    start = -1
    depth = 0
    in_string = False
    escape = False
    for i, c in enumerate(s):
        if in_string:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_string = False
            continue
        if c == '"':
            in_string = True
            continue
        if c == "{":
            if depth == 0:
                start = i
            depth += 1
        elif c == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    return s[start : i + 1]
    return None


def _extract_json_object(text: str) -> dict[str, Any]:
    text = _strip_markdown_json_fence((text or "").strip())
    if not text:
        raise ValueError("empty_model_output")
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass
    chunk = _first_balanced_json_object(text)
    if chunk:
        try:
            obj = json.loads(chunk)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    raise ValueError("invalid_json_in_model_output")


def parse_competitor_analysis_output(raw: str) -> tuple[str, str, str]:
    """
    解析竞品分析接口期望的 JSON：
    {"analysis_markdown":"...","generated":{"title":"...","body":"..."}}
    兼容模型把 title/body 放在顶层、或 generated 为字符串等畸形情况。
    """
    obj = _extract_json_object(raw)
    analysis = obj.get("analysis_markdown")
    if not isinstance(analysis, str):
        analysis = ""

    gen = obj.get("generated")
    title: str = ""
    body: str = ""
    if isinstance(gen, dict):
        t, b = gen.get("title"), gen.get("body")
        if isinstance(t, str):
            title = t
        if isinstance(b, str):
            body = b
    if not title.strip() and isinstance(obj.get("title"), str):
        title = str(obj["title"])
    if not body.strip() and isinstance(obj.get("body"), str):
        body = str(obj["body"])

    title = title.strip()[:500]
    body = body.strip()
    analysis = analysis.strip()
    if not analysis and not title and not body:
        raise ValueError("empty_competitor_payload")
    return analysis, title, body


def call_ollama_chat(
    *,
    system: str,
    user: str,
    response_format: str | dict[str, Any] | None = None,
) -> str:
    base = settings.ollama_base_url.rstrip("/")
    url = f"{base}/api/chat"
    timeout = httpx.Timeout(settings.ollama_timeout_seconds)
    payload: dict[str, Any] = {
        "model": settings.ollama_copy_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
    }
    if response_format is not None:
        # Ollama：约束为合法 JSON，显著降低「夹杂说明文字 / markdown」导致的解析失败
        payload["format"] = response_format
    # Dev 环境常见会设置 HTTP(S)_PROXY；Ollama 本机回环地址不应走代理，否则会被误判为“不可用”。
    with httpx.Client(timeout=timeout, trust_env=False) as client:
        r = client.post(url, json=payload)
        r.raise_for_status()
        data = r.json()
    msg = data.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, str):
        raise ValueError("missing_message_content")
    return content


def parse_generated_title_body(raw: str) -> tuple[str, str]:
    obj = _extract_json_object(raw)
    title = obj.get("title")
    body = obj.get("body")
    if not isinstance(title, str) or not isinstance(body, str):
        raise ValueError("title_body_not_strings")
    title = title.strip()[:500]
    body = body.strip()
    if not title and not body:
        raise ValueError("empty_title_and_body")
    return title, body


def build_copy_system_prompt() -> str:
    return (
        "你是小红书笔记文案作者，输出面向真实用户的短笔记。"
        "用户消息中会给出【文案模版名称】【适用场景】【段落结构说明】及可选元数据；"
        "你必须严格按【段落结构说明】安排正文结构（段序、起承转合、钩子与收尾），"
        "标题与整体语气须与模版名称、适用场景一致，不得写成与模版定位无关的泛文案。"
        "口吻口语化、有断句；避免「综上所述」「总而言之」等套话；避免夸张保过承诺。"
        "竞品与对标草稿仅用于结构与语气参考，须改写脱敏，不得照搬侵权内容。"
        "你必须只输出一个 JSON 对象，不要 markdown 代码围栏，不要其它说明文字。"
        'JSON 格式：{"title":"…","body":"…"}。'
        "title 不超过 80 字；body 为正文，可含换行与少量 emoji，总长度合理即可。"
    )
