from __future__ import annotations

import base64
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

from playwright.sync_api import (
    Browser,
    BrowserContext,
    Error as PlaywrightError,
    Page,
    TimeoutError as PwTimeoutError,
    sync_playwright,
)

from app.playwright_google.errors import (
    DownloadError,
    GenerationTimeoutError,
    LoginRequiredError,
    SelectorNotFoundError,
)
from app.playwright_google.selectors import GeminiSelectors

# 仅用于 Playwright 启动/连接，勿拼进发给 Gemini 的 PARAMS_JSON
_INTERNAL_CHROME_PARAM_KEYS = frozenset({"chrome_cdp_url", "chrome_profile_dir"})


def _params_for_prompt(params: dict[str, Any] | None) -> dict[str, Any]:
    if not params:
        return {}
    return {k: v for k, v in params.items() if k not in _INTERNAL_CHROME_PARAM_KEYS}


@dataclass(frozen=True)
class DownloadedImage:
    local_path: Path
    width: Optional[int] = None
    height: Optional[int] = None
    source_url: Optional[str] = None


@dataclass(frozen=True)
class RunArtifacts:
    screenshot_path: Optional[Path] = None
    html_path: Optional[Path] = None


def _debug_hint(artifacts: RunArtifacts) -> str:
    parts: list[str] = []
    if artifacts.screenshot_path:
        parts.append(f"screenshot={artifacts.screenshot_path}")
    if artifacts.html_path:
        parts.append(f"html={artifacts.html_path}")
    return (" (" + ", ".join(parts) + ")") if parts else ""


def _now_ms() -> int:
    return int(time.time() * 1000)


def _safe_filename(s: str, max_len: int = 80) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"[^a-zA-Z0-9\-_ .()（）【】\u4e00-\u9fff]+", "_", s)
    if not s:
        return "image"
    return s[:max_len].strip(" ._")


def _ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def _dump_debug(page: Page, debug_dir: Path) -> RunArtifacts:
    _ensure_dir(debug_dir)
    ts = _now_ms()
    screenshot_path = debug_dir / f"debug_{ts}.png"
    html_path = debug_dir / f"debug_{ts}.html"
    try:
        page.screenshot(path=str(screenshot_path), full_page=True)
    except Exception:
        screenshot_path = None
    try:
        html_path.write_text(page.content(), encoding="utf-8")
    except Exception:
        html_path = None
    return RunArtifacts(screenshot_path=screenshot_path, html_path=html_path)


def _pick_prompt_locator(page: Page):
    # Gemini sometimes uses textarea, sometimes a contenteditable div.
    ta = page.locator(GeminiSelectors.PROMPT_TEXTAREA)
    if ta.count() > 0:
        return ta.first
    ce = page.locator(GeminiSelectors.PROMPT_CONTENTEDITABLE)
    if ce.count() > 0:
        return ce.first
    return None


def _is_login_page(page: Page) -> bool:
    try:
        if page.locator(GeminiSelectors.SIGN_IN_TEXT).count() > 0:
            return True
        if page.locator(GeminiSelectors.ACCOUNT_CHOOSER_TEXT).count() > 0:
            return True
    except Exception:
        return False
    return False


def _wait_for_logged_in(page: Page, timeout_ms: int) -> None:
    """Wait until prompt input is available; raises LoginRequiredError otherwise."""
    deadline = time.time() + timeout_ms / 1000.0
    last_url = ""
    while time.time() < deadline:
        try:
            page.wait_for_load_state("domcontentloaded", timeout=2_000)
        except Exception:
            pass
        last_url = page.url
        loc = _pick_prompt_locator(page)
        if loc is not None:
            try:
                if loc.is_visible():
                    return
            except Exception:
                return
        if _is_login_page(page):
            # user may still be logging in; keep waiting
            time.sleep(0.8)
            continue
        time.sleep(0.8)
    raise LoginRequiredError(f"Gemini prompt input not available (url={last_url}). Please login in the opened browser.")


def _set_prompt(locator, prompt: str) -> None:
    try:
        locator.click(timeout=5_000)
    except Exception:
        pass
    try:
        locator.fill(prompt)
        return
    except Exception:
        # contenteditable path
        try:
            locator.press("Control+A")
            locator.type(prompt)
            return
        except Exception as e:
            raise SelectorNotFoundError(f"Failed to fill prompt input: {e!s}")


def _click_send(page: Page) -> None:
    btn = page.locator(GeminiSelectors.SEND_BUTTON)
    if btn.count() > 0:
        try:
            btn.first.click(timeout=5_000)
            return
        except Exception:
            pass
    # Fallback: press Enter
    loc = _pick_prompt_locator(page)
    if loc is None:
        raise SelectorNotFoundError("Prompt input not found; cannot send.")
    try:
        loc.press("Enter")
    except Exception as e:
        raise SelectorNotFoundError(f"Failed to submit prompt: {e!s}")


def _unique_image_srcs(srcs: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for s in srcs:
        if not s:
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _collect_image_srcs(page: Page) -> list[str]:
    # Best-effort: grab all <img src> under <main>
    imgs = page.locator(GeminiSelectors.IMAGE_IN_MAIN)
    srcs: list[str] = []
    try:
        for i in range(min(imgs.count(), 50)):
            src = imgs.nth(i).get_attribute("src")
            if src:
                srcs.append(src)
    except Exception:
        pass
    return _unique_image_srcs(srcs)


def _download_src_to_file(page: Page, src: str, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if src.startswith("data:image/"):
        try:
            header, b64 = src.split(",", 1)
            _ = header  # unused
            out_path.write_bytes(base64.b64decode(b64))
            return
        except Exception as e:
            raise DownloadError(f"Failed to decode data url: {e!s}")

    if src.startswith("blob:"):
        # Fetch blob from within browser context and return as base64
        try:
            b64: str = page.evaluate(
                """
                async (url) => {
                  const res = await fetch(url);
                  const blob = await res.blob();
                  const arr = new Uint8Array(await blob.arrayBuffer());
                  let s = '';
                  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
                  return btoa(s);
                }
                """,
                src,
            )
            out_path.write_bytes(base64.b64decode(b64))
            return
        except Exception as e:
            raise DownloadError(f"Failed to fetch blob url: {e!s}")

    if src.startswith("http://") or src.startswith("https://"):
        try:
            res = page.request.get(src, timeout=60_000)
            if not res.ok:
                raise DownloadError(f"HTTP {res.status} downloading image")
            out_path.write_bytes(res.body())
            return
        except DownloadError:
            raise
        except Exception as e:
            raise DownloadError(f"Failed to download via HTTP: {e!s}")

    raise DownloadError(f"Unsupported image src: {src[:40]}")


def _pick_page_for_cdp(context: BrowserContext) -> Page:
    """在已附加的 Chrome 里优先选已打开 Gemini 的标签页，否则用第一个标签或新开一页。"""
    pages = list(context.pages)
    for pg in pages:
        try:
            u = pg.url or ""
        except Exception:
            u = ""
        if "gemini.google.com" in u:
            return pg
    if pages:
        return pages[0]
    return context.new_page()


def run_gemini_image_turn(
    *,
    prompt: str,
    params: dict[str, Any] | None = None,
    user_data_dir: Path,
    output_dir: Path,
    headless: bool = False,
    gemini_url: str = "https://gemini.google.com/",
    login_timeout_ms: int = 180_000,
    generation_timeout_ms: int = 180_000,
    min_images: int = 1,
    debug_dir: Path | None = None,
    cdp_url: str | None = None,
) -> tuple[list[DownloadedImage], RunArtifacts]:
    """Open Gemini (headed), ensure login, submit prompt, then download generated images.

    This is best-effort automation; selectors may require maintenance.
    """
    params_for_prompt = _params_for_prompt(params)
    if params_for_prompt:
        prompt_to_send = prompt + "\n\n" + "PARAMS_JSON:\n" + json.dumps(params_for_prompt, ensure_ascii=False)
    else:
        prompt_to_send = prompt

    _ensure_dir(user_data_dir)
    _ensure_dir(output_dir)
    debug_dir = debug_dir or (output_dir / "_debug")

    with sync_playwright() as p:
        cdp_browser: Browser | None = None
        context2: BrowserContext
        page: Page
        owns_context = False

        if cdp_url and cdp_url.strip():
            cdp_browser = p.chromium.connect_over_cdp(cdp_url.strip())
            contexts = cdp_browser.contexts
            if not contexts:
                try:
                    cdp_browser.close()
                except Exception:
                    pass
                raise LoginRequiredError(
                    "CDP 已连接但没有任何浏览器上下文。请用带 --remote-debugging-port 的 Chrome 打开至少一个窗口后再试。"
                )
            context2 = contexts[0]
            page = _pick_page_for_cdp(context2)
        else:
            owns_context = True
            launch_kwargs: dict[str, Any] = {
                "user_data_dir": str(user_data_dir),
                "channel": "chrome",
                "headless": headless,
                "viewport": {"width": 1280, "height": 900},
            }
            if params and isinstance(params, dict):
                prof = params.get("chrome_profile_dir")
                if isinstance(prof, str) and prof.strip():
                    launch_kwargs["args"] = [f"--profile-directory={prof.strip()}"]

            context2 = p.chromium.launch_persistent_context(**launch_kwargs)
            page = context2.new_page()

        try:
            page.goto(gemini_url, wait_until="domcontentloaded", timeout=60_000)
            _wait_for_logged_in(page, login_timeout_ms)

            loc = _pick_prompt_locator(page)
            if loc is None:
                raise SelectorNotFoundError("Prompt input not found after login.")

            before_srcs = set(_collect_image_srcs(page))
            _set_prompt(loc, prompt_to_send)
            _click_send(page)

            deadline = time.time() + generation_timeout_ms / 1000.0
            last_srcs: list[str] = []
            while time.time() < deadline:
                time.sleep(1.5)
                srcs = [s for s in _collect_image_srcs(page) if s not in before_srcs]
                if len(srcs) >= min_images:
                    last_srcs = srcs
                    break
                last_srcs = srcs

            if len(last_srcs) < min_images:
                raise GenerationTimeoutError(f"Timed out waiting for images (got {len(last_srcs)}).")

            downloaded: list[DownloadedImage] = []
            base = _safe_filename(prompt)
            for idx, src in enumerate(last_srcs[:8], start=1):
                out_path = output_dir / f"{base}_{idx}.png"
                # If unknown type, we still save as .png; callers can convert if needed.
                _download_src_to_file(page, src, out_path)
                downloaded.append(DownloadedImage(local_path=out_path, source_url=src))

            return downloaded, RunArtifacts()

        except (PwTimeoutError, PlaywrightError) as e:
            artifacts = _dump_debug(page, debug_dir)
            raise GenerationTimeoutError(f"Playwright error: {e!s}{_debug_hint(artifacts)}") from e
        except Exception as e:
            artifacts = _dump_debug(page, debug_dir)
            # Re-raise known errors as-is; wrap unknown into DownloadError with debug pointers.
            if isinstance(e, (LoginRequiredError, SelectorNotFoundError, GenerationTimeoutError, DownloadError)):
                raise type(e)(f"{e!s}{_debug_hint(artifacts)}") from e
            raise DownloadError(f"Automation failed: {e!s}{_debug_hint(artifacts)}") from e
        finally:
            if cdp_browser is not None:
                try:
                    # 仅断开 Playwright 与 Chrome 的 CDP 连接，不退出你已手动打开的 Chrome
                    cdp_browser.close()
                except Exception:
                    pass
            elif owns_context:
                try:
                    context2.close()
                except Exception:
                    pass

