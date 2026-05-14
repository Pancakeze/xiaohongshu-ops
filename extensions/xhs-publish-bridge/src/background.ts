import type {
  ExternalMessage,
  FillResult,
  GeminiDomResult,
  GeminiExternalMessage,
  ScrapeTopNotesResult,
} from "./types";

/**
 * 图文笔记发布入口：需带 `target=image`，否则首屏常为「上传视频」。
 * 可经 payload.path 覆盖。
 */
const DEFAULT_PATH = "/publish/publish?source=official&target=image";

const MAX_FETCH_BYTES = 6 * 1024 * 1024;

function targetUrl(path?: string): string {
  const p = path && path.startsWith("/") ? path : DEFAULT_PATH;
  return `https://creator.xiaohongshu.com${p}`;
}

function isBridgeMessage(msg: unknown): msg is ExternalMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return m.channel === "XHS_PUBLISH_BRIDGE" && m.version === 1 && typeof m.action === "string";
}

function bufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** Content → Background：拉取首图（绕开创作页对第三方 URL 的 CORS） */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    !message ||
    typeof message !== "object" ||
    (message as { channel?: string }).channel !== "XHS_PUBLISH_BRIDGE" ||
    (message as { action?: string }).action !== "FETCH_IMAGE_BLOB"
  ) {
    return false;
  }
  const url = (message as { url?: string }).url;
  if (
    !url ||
    typeof url !== "string" ||
    (!url.startsWith("https://") &&
      !url.startsWith("http://127.0.0.1") &&
      !url.startsWith("http://localhost"))
  ) {
    sendResponse({ ok: false, error: "bad_url" });
    return false;
  }
  void (async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) {
        sendResponse({ ok: false, error: `http_${r.status}` });
        return;
      }
      const buf = await r.arrayBuffer();
      if (buf.byteLength > MAX_FETCH_BYTES) {
        sendResponse({ ok: false, error: "image_too_large" });
        return;
      }
      const mime = r.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
      sendResponse({ ok: true, base64: bufferToBase64(buf), mime });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

async function ensureTab(url: string): Promise<{ tabId: number; reusedAndNavigated: boolean }> {
  const tabs = await chrome.tabs.query({ url: "https://creator.xiaohongshu.com/*" });
  const existing = tabs.find((t) => t.id != null && (t.url || "").includes("/publish/"));
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { url, active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return { tabId: existing.id, reusedAndNavigated: true };
  }
  const created = await chrome.tabs.create({ url, active: true });
  if (created.id == null) throw new Error("tab_create_failed");
  return { tabId: created.id, reusedAndNavigated: false };
}

async function ensureSearchTab(url: string): Promise<{ tabId: number; reusedAndNavigated: boolean }> {
  const tabs = await chrome.tabs.query({ url: "https://www.xiaohongshu.com/*" });
  const existing = tabs.find((t) => t.id != null && (t.url || "").includes("/search_result"));
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { url, active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return { tabId: existing.id, reusedAndNavigated: true };
  }
  const created = await chrome.tabs.create({ url, active: true });
  if (created.id == null) throw new Error("tab_create_failed");
  return { tabId: created.id, reusedAndNavigated: false };
}

async function ensureProfileTab(url: string): Promise<{ tabId: number; reusedAndNavigated: boolean }> {
  const tabs = await chrome.tabs.query({ url: "https://www.xiaohongshu.com/*" });
  const existing = tabs.find((t) => t.id != null && (t.url || "").includes("/user/profile/"));
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { url, active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return { tabId: existing.id, reusedAndNavigated: true };
  }
  const created = await chrome.tabs.create({ url, active: true });
  if (created.id == null) throw new Error("tab_create_failed");
  return { tabId: created.id, reusedAndNavigated: false };
}

async function ensureExploreTab(url: string): Promise<{ tabId: number; reusedAndNavigated: boolean }> {
  const tabs = await chrome.tabs.query({ url: "https://www.xiaohongshu.com/*" });
  const existing = tabs.find((t) => t.id != null && (t.url || "").includes("/explore/"));
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { url, active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return { tabId: existing.id, reusedAndNavigated: true };
  }
  const created = await chrome.tabs.create({ url, active: true });
  if (created.id == null) throw new Error("tab_create_failed");
  return { tabId: created.id, reusedAndNavigated: false };
}

/**
 * 等标签进入 complete。复用标签并 update(url) 时，旧页往往仍是 complete，不能立刻 tabs.get 当「已加载好」。
 */
function waitTabComplete(
  tabId: number,
  timeoutMs: number,
  opts?: { ignoreImmediateComplete?: boolean; expectedUrlPrefix?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      reject(new Error("tab_load_timeout"));
    }, timeoutMs);
    function onUpd(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id !== tabId) return;
      if (info.status === "complete") {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpd);
    const expected = (opts?.expectedUrlPrefix || "").trim();
    const pollMs = 500;
    const poll = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        const okUrl = !expected || (tab.url || "").startsWith(expected);
        if (okUrl && tab.status === "complete") {
          clearTimeout(t);
          chrome.tabs.onUpdated.removeListener(onUpd);
          resolve();
          return;
        }
      } catch {
        /* ignore */
      }
      setTimeout(poll, pollMs);
    };
    // 无论是否 ignoreImmediateComplete，都做轮询兜底：SPA/重定向场景下 onUpdated 可能错过或不触发 complete
    void poll();

    if (!opts?.ignoreImmediateComplete) {
      void chrome.tabs.get(tabId).then((tab) => {
        const okUrl = !expected || (tab.url || "").startsWith(expected);
        if (okUrl && tab.status === "complete") {
          clearTimeout(t);
          chrome.tabs.onUpdated.removeListener(onUpd);
          resolve();
        }
      });
    }
  });
}

async function fillOnTab(
  tabId: number,
  title: string,
  body: string,
  firstImageUrl?: string,
  imageUrls?: string[]
): Promise<FillResult> {
  const msg = {
    channel: "XHS_PUBLISH_BRIDGE" as const,
    action: "FILL_DOM" as const,
    payload: { title, body, firstImageUrl, imageUrls }
  };
  const maxAttempts = 10;
  const delayMs = 500;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs));
    else await new Promise((r) => setTimeout(r, 400));
    try {
      const res = await chrome.tabs.sendMessage(tabId, msg);
      return (res as FillResult) || { ok: false, detail: "no_content_response" };
    } catch (e) {
      const s = String(e);
      const retryable =
        s.includes("Could not establish connection") ||
        s.includes("Receiving end does not exist") ||
        s.includes("The message port closed");
      if (!retryable || attempt === maxAttempts - 1) {
        return { ok: false, detail: s };
      }
    }
  }
  return { ok: false, detail: "fill_retries_exhausted" };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isBridgeMessage(message)) {
    return false;
  }
  if (message.action === "PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return;
  }
  if (message.action === "SCRAPE_TOP_NOTES") {
    void (async () => {
      const keyword = String(message.payload?.keyword || "").trim();
      const limitRaw = Number((message.payload as { limit?: number } | undefined)?.limit ?? 10);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, Math.floor(limitRaw))) : 10;
      if (!keyword) {
        const r: ScrapeTopNotesResult = { ok: false, error: "missing_keyword" };
        sendResponse(r);
        return;
      }
      const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`;
      try {
        const { tabId, reusedAndNavigated } = await ensureSearchTab(url);
        await waitTabComplete(tabId, 25000, { ignoreImmediateComplete: reusedAndNavigated, expectedUrlPrefix: "https://www.xiaohongshu.com/" });
        await new Promise((r) => setTimeout(r, reusedAndNavigated ? 1600 : 1200));
        const inner = {
          channel: "XHS_PUBLISH_BRIDGE" as const,
          action: "SCRAPE_SEARCH_DOM" as const,
          payload: { limit }
        };
        const res = (await chrome.tabs.sendMessage(tabId, inner)) as unknown;
        const obj = (res && typeof res === "object" ? (res as Record<string, unknown>) : null) || null;
        const ok = Boolean(obj && obj.ok);
        if (!ok) {
          const r: ScrapeTopNotesResult = {
            ok: false,
            error: typeof obj?.error === "string" ? String(obj.error) : "scrape_failed",
            detail: typeof obj?.detail === "string" ? String(obj.detail) : undefined,
            tabId
          };
          sendResponse(r);
          return;
        }
        const items = Array.isArray(obj?.items) ? (obj?.items as unknown[]) : [];
        const outItems = items
          .filter((x) => x && typeof x === "object")
          .map((x) => x as Record<string, unknown>)
          .map((x) => ({
            url: typeof x.url === "string" ? x.url : "",
            title: typeof x.title === "string" ? x.title : "",
            author: typeof x.author === "string" ? x.author : undefined,
            excerpt: typeof x.excerpt === "string" ? x.excerpt : undefined,
            like_text: typeof x.like_text === "string" ? x.like_text : undefined
          }))
          .filter((x) => x.url && x.title)
          .slice(0, limit);
        const r: ScrapeTopNotesResult = { ok: true, keyword, items: outItems, tabId };
        sendResponse(r);
      } catch (e) {
        const r: ScrapeTopNotesResult = { ok: false, error: "scrape_exception", detail: String(e) };
        sendResponse(r);
      }
    })();
    return true;
  }
  if (message.action === "SCRAPE_PROFILE_NOTES") {
    void (async () => {
      const profileUrl = String(message.payload?.profileUrl || "").trim();
      const limitRaw = Number((message.payload as { limit?: number } | undefined)?.limit ?? 10);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, Math.floor(limitRaw))) : 10;
      if (!profileUrl) {
        const r: ScrapeTopNotesResult = { ok: false, error: "missing_profile_url" };
        sendResponse(r);
        return;
      }
      if (!profileUrl.startsWith("https://www.xiaohongshu.com/user/profile/")) {
        const r: ScrapeTopNotesResult = { ok: false, error: "bad_profile_url" };
        sendResponse(r);
        return;
      }
      try {
        const { tabId, reusedAndNavigated } = await ensureProfileTab(profileUrl);
        await waitTabComplete(tabId, 25000, { ignoreImmediateComplete: reusedAndNavigated, expectedUrlPrefix: "https://www.xiaohongshu.com/" });
        await new Promise((r) => setTimeout(r, reusedAndNavigated ? 1600 : 1200));
        const inner = {
          channel: "XHS_PUBLISH_BRIDGE" as const,
          action: "SCRAPE_PAGE_NOTES" as const,
          payload: { limit }
        };
        const res = (await chrome.tabs.sendMessage(tabId, inner)) as unknown;
        const obj = (res && typeof res === "object" ? (res as Record<string, unknown>) : null) || null;
        const ok = Boolean(obj && obj.ok);
        if (!ok) {
          const r: ScrapeTopNotesResult = {
            ok: false,
            error: typeof obj?.error === "string" ? String(obj.error) : "scrape_failed",
            detail: typeof obj?.detail === "string" ? String(obj.detail) : undefined,
            tabId
          };
          sendResponse(r);
          return;
        }
        const items = Array.isArray(obj?.items) ? (obj?.items as unknown[]) : [];
        const outItems = items
          .filter((x) => x && typeof x === "object")
          .map((x) => x as Record<string, unknown>)
          .map((x) => ({
            url: typeof x.url === "string" ? x.url : "",
            title: typeof x.title === "string" ? x.title : "",
            author: typeof x.author === "string" ? x.author : undefined,
            excerpt: typeof x.excerpt === "string" ? x.excerpt : undefined,
            like_text: typeof x.like_text === "string" ? x.like_text : undefined
          }))
          .filter((x) => x.url && x.title)
          .slice(0, limit);
        const r: ScrapeTopNotesResult = { ok: true, keyword: profileUrl, items: outItems, tabId };
        sendResponse(r);
      } catch (e) {
        const r: ScrapeTopNotesResult = { ok: false, error: "scrape_exception", detail: String(e) };
        sendResponse(r);
      }
    })();
    return true;
  }
  if (message.action === "SCRAPE_NOTE_RELATED") {
    void (async () => {
      const noteUrl = String(message.payload?.noteUrl || "").trim();
      const limitRaw = Number((message.payload as { limit?: number } | undefined)?.limit ?? 10);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, Math.floor(limitRaw))) : 10;
      if (!noteUrl) {
        sendResponse({ ok: false, error: "missing_note_url" });
        return;
      }
      if (!noteUrl.startsWith("https://www.xiaohongshu.com/explore/")) {
        sendResponse({ ok: false, error: "bad_note_url" });
        return;
      }
      try {
        const { tabId, reusedAndNavigated } = await ensureExploreTab(noteUrl);
        await waitTabComplete(tabId, 25000, { ignoreImmediateComplete: reusedAndNavigated, expectedUrlPrefix: "https://www.xiaohongshu.com/" });
        await new Promise((r) => setTimeout(r, reusedAndNavigated ? 1700 : 1300));
        const inner = {
          channel: "XHS_PUBLISH_BRIDGE" as const,
          action: "SCRAPE_EXPLORE_RELATED_DOM" as const,
          payload: { limit }
        };
        const res = (await chrome.tabs.sendMessage(tabId, inner)) as unknown;
        const obj = (res && typeof res === "object" ? (res as Record<string, unknown>) : null) || null;
        const ok = Boolean(obj && obj.ok);
        if (!ok) {
          sendResponse({
            ok: false,
            error: typeof obj?.error === "string" ? String(obj.error) : "scrape_failed",
            detail: typeof obj?.detail === "string" ? String(obj.detail) : undefined,
            tabId
          });
          return;
        }
        const items = Array.isArray(obj?.items) ? (obj?.items as unknown[]) : [];
        const outItems = items
          .filter((x) => x && typeof x === "object")
          .map((x) => x as Record<string, unknown>)
          .map((x) => ({
            url: typeof x.url === "string" ? x.url : "",
            title: typeof x.title === "string" ? x.title : "",
            author: typeof x.author === "string" ? x.author : undefined,
            excerpt: typeof x.excerpt === "string" ? x.excerpt : undefined,
            like_text: typeof x.like_text === "string" ? x.like_text : undefined
          }))
          .filter((x) => x.url && x.title)
          .slice(0, limit);
        sendResponse({ ok: true, keyword: noteUrl, items: outItems, tabId });
      } catch (e) {
        sendResponse({ ok: false, error: "scrape_exception", detail: String(e) });
      }
    })();
    return true;
  }
  if (message.action !== "FILL_IMG_NOTE") {
    sendResponse({ ok: false, error: "unsupported_action" });
    return;
  }

  void (async () => {
    const { title, body, path, firstImageUrl, imageUrls } = message.payload;
    const url = targetUrl(path);
    try {
      const { tabId, reusedAndNavigated } = await ensureTab(url);
      try {
        await waitTabComplete(tabId, 25000, {
          ignoreImmediateComplete: reusedAndNavigated,
          expectedUrlPrefix: "https://creator.xiaohongshu.com/",
        });
      } catch (e) {
        // 创作页是 SPA/重定向较多，偶尔长时间不进入 complete；超时也继续尝试 fill（fillOnTab 自带重试）
        const msg = String(e);
        if (!msg.includes("tab_load_timeout")) throw e;
      }
      await new Promise((r) => setTimeout(r, reusedAndNavigated ? 1900 : 1300));
      const r = await fillOnTab(tabId, title, body, firstImageUrl, imageUrls);
      sendResponse({ ok: r.ok, result: r, tabId });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});

function isGeminiExternalMessage(msg: unknown): msg is GeminiExternalMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return m.channel === "GEMINI_IMAGE_BRIDGE" && m.version === 1 && typeof m.action === "string";
}

function normalizeApiBase(u: string): string {
  return u.replace(/\/$/, "");
}

async function ensureGeminiTab(url: string): Promise<{ tabId: number; reusedAndNavigated: boolean }> {
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  const existing = tabs.find((t) => t.id != null && (t.url || "").includes("gemini.google.com"));
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { url, active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return { tabId: existing.id, reusedAndNavigated: true };
  }
  const created = await chrome.tabs.create({ url, active: true });
  if (created.id == null) throw new Error("tab_create_failed");
  return { tabId: created.id, reusedAndNavigated: false };
}

async function runGeminiDomOnTab(
  tabId: number,
  prompt: string,
  params: Record<string, unknown>
): Promise<GeminiDomResult> {
  const msg = {
    channel: "GEMINI_IMAGE_BRIDGE" as const,
    action: "RUN_TURN_DOM" as const,
    payload: { prompt, params },
  };
  const maxAttempts = 14;
  const delayMs = 500;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs));
    else await new Promise((r) => setTimeout(r, 600));
    try {
      const res = (await chrome.tabs.sendMessage(tabId, msg)) as GeminiDomResult | undefined;
      if (res && typeof res === "object" && "ok" in res) return res;
      return { ok: false, error: "no_dom_response" };
    } catch (e) {
      const s = String(e);
      const retryable =
        s.includes("Could not establish connection") ||
        s.includes("Receiving end does not exist") ||
        s.includes("The message port closed");
      if (!retryable || attempt === maxAttempts - 1) {
        return { ok: false, error: "send_message_failed", detail: s };
      }
    }
  }
  return { ok: false, error: "retries_exhausted" };
}

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (!isGeminiExternalMessage(message)) {
    return false;
  }
  if (message.action === "PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version, channel: "GEMINI_IMAGE_BRIDGE" });
    return false;
  }
  if (message.action !== "GEMINI_RUN_TURN") {
    return false;
  }

  void (async () => {
    const p = message.payload;
    const prompt = String(p.prompt || "").trim();
    const sessionId = String(p.sessionId || "").trim();
    const apiBaseUrl = normalizeApiBase(String(p.apiBaseUrl || "").trim());
    const bearerToken = String(p.bearerToken || "").trim();
    if (!prompt || !sessionId || !apiBaseUrl || !bearerToken) {
      sendResponse({ ok: false, error: "missing_required_fields" });
      return;
    }
    const geminiUrl = "https://gemini.google.com/";
    try {
      const { tabId, reusedAndNavigated } = await ensureGeminiTab(geminiUrl);
      await waitTabComplete(tabId, 35000, {
        ignoreImmediateComplete: reusedAndNavigated,
        expectedUrlPrefix: "https://gemini.google.com/",
      });
      await new Promise((r) => setTimeout(r, reusedAndNavigated ? 1400 : 900));
      const params =
        p.params && typeof p.params === "object" && !Array.isArray(p.params)
          ? (p.params as Record<string, unknown>)
          : {};
      const dom = await runGeminiDomOnTab(tabId, prompt, params);
      if (!dom.ok) {
        sendResponse({ ok: false, error: dom.error, detail: dom.detail });
        return;
      }
      const res = await fetch(`${apiBaseUrl}/api/google-image/sessions/${sessionId}/turns/via-extension`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({
          prompt,
          params,
          images: dom.images,
          write_to_draft_pool: Boolean(p.writeToDraftPool),
          entry_id: p.entryId && String(p.entryId).trim() ? String(p.entryId).trim() : null,
          source_copy_version_id:
            p.sourceCopyVersionId && String(p.sourceCopyVersionId).trim()
              ? String(p.sourceCopyVersionId).trim()
              : null,
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        sendResponse({ ok: false, error: `api_http_${res.status}`, detail: text.slice(0, 1200) });
        return;
      }
      let turn: unknown;
      try {
        turn = JSON.parse(text) as unknown;
      } catch {
        sendResponse({ ok: false, error: "api_bad_json", detail: text.slice(0, 200) });
        return;
      }
      sendResponse({ ok: true, turn });
    } catch (e) {
      sendResponse({ ok: false, error: "exception", detail: String(e) });
    }
  })();
  return true;
});
