import type { ExternalMessage, FillResult } from "./types";

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

/**
 * 等标签进入 complete。复用标签并 update(url) 时，旧页往往仍是 complete，不能立刻 tabs.get 当「已加载好」。
 */
function waitTabComplete(
  tabId: number,
  timeoutMs: number,
  opts?: { ignoreImmediateComplete?: boolean }
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
    if (!opts?.ignoreImmediateComplete) {
      void chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete") {
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
    sendResponse({ ok: false, error: "unknown_message" });
    return;
  }
  if (message.action === "PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return;
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
      await waitTabComplete(tabId, 25000, { ignoreImmediateComplete: reusedAndNavigated });
      await new Promise((r) => setTimeout(r, reusedAndNavigated ? 1800 : 1200));
      const r = await fillOnTab(tabId, title, body, firstImageUrl, imageUrls);
      sendResponse({ ok: r.ok, result: r, tabId });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});
