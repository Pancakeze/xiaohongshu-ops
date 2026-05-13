from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

import httpx
from bs4 import BeautifulSoup


@dataclass(frozen=True)
class ScrapedPage:
    url: str
    ok: bool
    error: Optional[str] = None
    title: str = ""
    description: str = ""
    text_excerpt: str = ""
    text_len: int = 0


_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)


def _norm_ws(s: str) -> str:
    s = (s or "").strip()
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _pick_meta(soup: BeautifulSoup, *, prop: str) -> str:
    tag = soup.find("meta", attrs={"property": prop})
    if tag and tag.get("content"):
        return str(tag.get("content") or "").strip()
    tag = soup.find("meta", attrs={"name": prop})
    if tag and tag.get("content"):
        return str(tag.get("content") or "").strip()
    return ""


def _extract_visible_text(soup: BeautifulSoup) -> str:
    for t in soup(["script", "style", "noscript", "svg"]):
        try:
            t.decompose()
        except Exception:
            pass
    body = soup.body or soup
    text = body.get_text("\n", strip=True)
    return _norm_ws(text)


def scrape_url(
    url: str,
    *,
    timeout_seconds: float = 15.0,
    max_bytes: int = 1_200_000,
) -> ScrapedPage:
    u = (url or "").strip()
    if not u:
        return ScrapedPage(url=url, ok=False, error="empty_url")
    if not (u.startswith("http://") or u.startswith("https://")):
        return ScrapedPage(url=u, ok=False, error="unsupported_url_scheme")

    try:
        timeout = httpx.Timeout(timeout_seconds)
        headers = {"User-Agent": _UA, "Accept": "text/html,application/xhtml+xml"}
        # trust_env=False：避免代理配置干扰抓取
        with httpx.Client(timeout=timeout, follow_redirects=True, trust_env=False, headers=headers) as client:
            r = client.get(u)
            r.raise_for_status()
            content_type = (r.headers.get("content-type") or "").lower()
            if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                # 有些站会返回 text/plain，但内容仍是 HTML；这里不强卡死，只是降级处理
                pass
            raw = r.content[:max_bytes]
    except httpx.TimeoutException:
        return ScrapedPage(url=u, ok=False, error="timeout")
    except httpx.HTTPStatusError as e:
        return ScrapedPage(url=u, ok=False, error=f"http_{e.response.status_code}")
    except httpx.HTTPError:
        return ScrapedPage(url=u, ok=False, error="http_error")

    try:
        html = raw.decode(r.encoding or "utf-8", errors="ignore")
    except Exception:
        html = raw.decode("utf-8", errors="ignore")

    soup = BeautifulSoup(html, "lxml")

    title = ""
    if soup.title and soup.title.string:
        title = str(soup.title.string).strip()
    og_title = _pick_meta(soup, prop="og:title")
    if og_title:
        title = og_title.strip()

    desc = _pick_meta(soup, prop="description")
    og_desc = _pick_meta(soup, prop="og:description")
    if og_desc:
        desc = og_desc.strip()

    text = _extract_visible_text(soup)
    excerpt = text[:900]
    if len(text) > 900:
        excerpt = excerpt[:899] + "…"

    return ScrapedPage(
        url=u,
        ok=True,
        error=None,
        title=title[:300],
        description=desc[:800],
        text_excerpt=excerpt,
        text_len=len(text),
    )


def score_page(p: ScrapedPage) -> int:
    """启发式：可读文本越多越优；title/desc 非空略加分。"""
    if not p.ok:
        return -10_000
    s = min(p.text_len, 50_000) // 50  # 0..1000
    if p.title.strip():
        s += 40
    if p.description.strip():
        s += 20
    return int(s)

