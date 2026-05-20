import type {
  CreatorPublishedNoteRow,
  ExternalMessage,
  FillResult,
  GeminiDomResult,
  GeminiExternalMessage,
  ScrapeCreatorPublishedResult,
  ScrapeTopNotesResult,
} from "./types";

const CREATOR_ANALYTICS_URL =
  "https://creator.xiaohongshu.com/statistics/data-analysis?source=official";
const CREATOR_NOTE_MANAGER_URL =
  "https://creator.xiaohongshu.com/new/note-manager?source=official";

/**
 * 图文笔记发布入口：需带 `target=image`，否则首屏常为「上传视频」。
 * 可经 payload.path 覆盖。
 */
const DEFAULT_PATH = "/publish/publish?source=official&target=image";

const MAX_FETCH_BYTES = 6 * 1024 * 1024;

function bridgeLog(...args: unknown[]): void {
  console.log("[xhs-publish-bridge]", ...args);
}

type ExploreCaptureWaiter = {
  resolve: (url: string | undefined) => void;
  timeout: ReturnType<typeof setTimeout>;
};

let exploreCaptureWaiter: ExploreCaptureWaiter | null = null;
let pendingExploreCapture: Promise<string | undefined> | null = null;
let pendingExploreCaptureOpts: { watchTabId?: number; returnUrl?: string } | null = null;
let exploreCaptureOnUpdated: ((id: number, info: chrome.tabs.TabChangeInfo) => void) | null = null;

/** 笔记管理点封面后常见：/explore/{noteId}?xsec_token=…&xsec_source=pc_creatormng */
function isExploreNoteUrl(url: string): boolean {
  const u = url.trim();
  if (!u || u.includes("creator.xiaohongshu.com")) return false;
  return /xiaohongshu\.com\/explore\/[a-f0-9]{16,}/i.test(u);
}

/** 拼接 explore/{noteId} 打开会 404；或笔记暂不可浏览 */
function isRejectedNoteUrl(url: string): boolean {
  const u = url.trim();
  if (!u) return true;
  if (/xiaohongshu\.com\/404/i.test(u)) return true;
  if (/error_code=300031/i.test(u)) return true;
  try {
    if (decodeURIComponent(u).includes("暂时无法浏览")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** 仅接受点封面打开、带 xsec_token 的 explore 页 */
function isCapturedExploreUrl(url: string): boolean {
  if (isRejectedNoteUrl(url)) return false;
  if (!isExploreNoteUrl(url)) return false;
  if (url.includes("xsec_token")) return true;
  if (/xsec_source=pc_creatormng/.test(url) && !url.includes("xsec_token")) return false;
  return false;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function findExploreUrlInOpenTabs(watchTabId?: number): Promise<string | undefined> {
  const tabs = await chrome.tabs.query({});
  let sameTabUrl: string | undefined;
  let newTabUrl: string | undefined;
  for (const t of tabs) {
    const candidate = (t.pendingUrl || t.url || "").trim();
    if (!candidate || !isCapturedExploreUrl(candidate) || t.id == null) continue;
    if (watchTabId != null && t.id === watchTabId) {
      sameTabUrl = candidate;
    } else {
      newTabUrl = candidate;
    }
  }
  return newTabUrl || sameTabUrl;
}

async function pollExploreUrlAfterClick(
  watchTabId: number | undefined,
  returnUrl: string | undefined,
  timeoutMs = 4000
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await closeRejectedExploreTabs();
    const hit = await findExploreUrlInOpenTabs(watchTabId);
    if (hit) {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        const candidate = (t.pendingUrl || t.url || "").trim();
        if (candidate !== hit || t.id == null) continue;
        const isNew = watchTabId != null && t.id !== watchTabId;
        const isSame = watchTabId != null && t.id === watchTabId;
        if (isNew) {
          await chrome.tabs.remove(t.id).catch(() => undefined);
        } else if (isSame && returnUrl) {
          await chrome.tabs.update(t.id, { url: returnUrl, active: true }).catch(() => undefined);
        }
        break;
      }
      return hit;
    }
    await sleepMs(180);
  }
  return undefined;
}

function disarmExploreCaptureListeners() {
  if (exploreCaptureOnUpdated) {
    chrome.tabs.onUpdated.removeListener(exploreCaptureOnUpdated);
    exploreCaptureOnUpdated = null;
  }
}

function finishExploreCapture(
  url: string | undefined,
  opts?: { closeTabId?: number; restoreTabId?: number; restoreUrl?: string }
) {
  const waiter = exploreCaptureWaiter;
  if (!waiter) return;
  clearTimeout(waiter.timeout);
  exploreCaptureWaiter = null;
  disarmExploreCaptureListeners();
  waiter.resolve(url);
  if (opts?.restoreTabId != null && opts.restoreUrl) {
    void chrome.tabs.update(opts.restoreTabId, { url: opts.restoreUrl, active: true }).catch(() => undefined);
  } else if (opts?.closeTabId != null) {
    void chrome.tabs.remove(opts.closeTabId).catch(() => undefined);
  }
}

function beginExploreCapture(
  timeoutMs = 12000,
  opts?: { watchTabId?: number; returnUrl?: string }
): Promise<string | undefined> {
  if (exploreCaptureWaiter) {
    clearTimeout(exploreCaptureWaiter.timeout);
    exploreCaptureWaiter.resolve(undefined);
    exploreCaptureWaiter = null;
    disarmExploreCaptureListeners();
  }
  const watchTabId = opts?.watchTabId;
  const returnUrl = opts?.returnUrl;

  return new Promise((resolve) => {
    // 超时勿强制 tabs.update(returnUrl)，否则笔记管理页会反复整页刷新
    const timeout = setTimeout(() => {
      finishExploreCapture(undefined);
    }, timeoutMs);

    exploreCaptureOnUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (!exploreCaptureWaiter) return;
      const candidate = (info.url || "").trim();
      if (!candidate || !isExploreNoteUrl(candidate)) return;
      if (!isCapturedExploreUrl(candidate) && info.status !== "complete") return;

      const isNewTab = watchTabId == null || id !== watchTabId;
      const isSameTab = watchTabId != null && id === watchTabId;
      if (!isNewTab && !isSameTab) return;
      if (!isCapturedExploreUrl(candidate)) return;

      finishExploreCapture(candidate, {
        closeTabId: isNewTab ? id : undefined,
        restoreTabId: isSameTab ? watchTabId : undefined,
        restoreUrl: isSameTab ? returnUrl : undefined
      });
    };
    chrome.tabs.onUpdated.addListener(exploreCaptureOnUpdated);

    exploreCaptureWaiter = { resolve, timeout };
  });
}

chrome.tabs.onCreated.addListener((tab) => {
  if (!exploreCaptureWaiter || tab.id == null) return;
  void chrome.tabs
    .get(tab.id)
    .then((t) => {
      const candidate = (t.pendingUrl || t.url || "").trim();
      if (candidate && isCapturedExploreUrl(candidate)) {
        finishExploreCapture(candidate, { closeTabId: tab.id });
      }
    })
    .catch(() => undefined);
});

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

/** Content → Background：拉取首图 / 捕获点击标题后打开的 explore 标签页 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    !message ||
    typeof message !== "object" ||
    (message as { channel?: string }).channel !== "XHS_PUBLISH_BRIDGE"
  ) {
    return false;
  }
  const action = (message as { action?: string }).action;

  if (action === "BEGIN_EXPLORE_CAPTURE") {
    const senderTabId = _sender.tab?.id;
    const captureOpts = {
      watchTabId:
        typeof (message as { watchTabId?: number }).watchTabId === "number"
          ? (message as { watchTabId: number }).watchTabId
          : senderTabId,
      returnUrl:
        typeof (message as { returnUrl?: string }).returnUrl === "string"
          ? (message as { returnUrl: string }).returnUrl
          : undefined
    };
    pendingExploreCaptureOpts = captureOpts;
    pendingExploreCapture = beginExploreCapture(
      Number((message as { timeoutMs?: number }).timeoutMs) || 12000,
      captureOpts
    );
    sendResponse({ ok: true });
    return true;
  }

  if (action === "WAIT_EXPLORE_CAPTURE") {
    void (async () => {
      const senderTabId = _sender.tab?.id;
      const captureOpts =
        pendingExploreCaptureOpts ||
        (senderTabId != null ? { watchTabId: senderTabId, returnUrl: undefined as string | undefined } : null);
      let url = pendingExploreCapture ? await pendingExploreCapture : undefined;
      pendingExploreCapture = null;
      pendingExploreCaptureOpts = null;
      if (!url && captureOpts) {
        url = await pollExploreUrlAfterClick(captureOpts.watchTabId, captureOpts.returnUrl);
      }
      sendResponse({ ok: true, url: url || undefined });
    })();
    return true;
  }

  if (action !== "FETCH_IMAGE_BLOB") {
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

async function ensureCreatorAnalyticsTab(
  url: string
): Promise<{ tabId: number; reusedAndNavigated: boolean }> {
  const tabs = await chrome.tabs.query({ url: "https://creator.xiaohongshu.com/*" });
  const existing = tabs.find(
    (t) => t.id != null && (t.url || "").includes("/statistics/data-analysis")
  );
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { url, active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return { tabId: existing.id, reusedAndNavigated: true };
  }
  const anyCreator = tabs.find((t) => t.id != null);
  if (anyCreator?.id != null) {
    await chrome.tabs.update(anyCreator.id, { url, active: true });
    if (anyCreator.windowId != null) {
      await chrome.windows.update(anyCreator.windowId, { focused: true });
    }
    return { tabId: anyCreator.id, reusedAndNavigated: true };
  }
  const created = await chrome.tabs.create({ url, active: true });
  if (created.id == null) throw new Error("tab_create_failed");
  return { tabId: created.id, reusedAndNavigated: false };
}

/** 优先复用已打开的笔记管理页；否则把任意创作中心 Tab 导航到笔记管理（不抢数据分析页逻辑） */
async function ensureCreatorNoteManagerTab(): Promise<{
  tabId: number;
  reusedAndNavigated: boolean;
}> {
  const tabs = await chrome.tabs.query({ url: "https://creator.xiaohongshu.com/*" });
  const onManager = tabs.find(
    (t) => t.id != null && (t.url || "").includes("/new/note-manager")
  );
  if (onManager?.id != null) {
    await chrome.tabs.update(onManager.id, { active: true });
    if (onManager.windowId != null) {
      await chrome.windows.update(onManager.windowId, { focused: true });
    }
    return { tabId: onManager.id, reusedAndNavigated: false };
  }
  const anyCreator = tabs.find((t) => t.id != null);
  if (anyCreator?.id != null) {
    await chrome.tabs.update(anyCreator.id, { url: CREATOR_NOTE_MANAGER_URL, active: true });
    if (anyCreator.windowId != null) {
      await chrome.windows.update(anyCreator.windowId, { focused: true });
    }
    return { tabId: anyCreator.id, reusedAndNavigated: true };
  }
  const created = await chrome.tabs.create({ url: CREATOR_NOTE_MANAGER_URL, active: true });
  if (created.id == null) throw new Error("tab_create_failed");
  return { tabId: created.id, reusedAndNavigated: false };
}

type CreatorLinkRow = {
  title: string;
  official_url?: string;
  note_id?: string;
  published_at?: string;
  cover_url?: string;
  publish_status?: string;
  watch_count?: number;
  likes?: number;
  comments?: number;
  favorites?: number;
  shares?: number;
};

function extractNoteIdFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/explore\/([a-f0-9]{16,})/i);
  return m ? m[1].toLowerCase() : undefined;
}

function normPublishedTitleKey(title: string): string {
  return title
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase()
    .replace(/^未通过/, "");
}

function titleMatchesPublished(want: string, got: string): boolean {
  const a = normPublishedTitleKey(want);
  const b = normPublishedTitleKey(got);
  if (!a || !b) return false;
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const prefixLen = Math.min(12, minLen);
  return a.slice(0, prefixLen) === b.slice(0, prefixLen);
}

function filterLinkRowsByMatchTitles(
  rows: CreatorLinkRow[],
  matchTitles: string[]
): CreatorLinkRow[] {
  const out: CreatorLinkRow[] = [];
  const used = new Set<string>();
  for (const want of matchTitles) {
    let hit = rows.find((r) => titleMatchesPublished(want, r.title));
    if (!hit) {
      let best: CreatorLinkRow | undefined;
      let bestScore = 0.24;
      for (const r of rows) {
        const a = normPublishedTitleKey(want);
        const b = normPublishedTitleKey(r.title);
        if (!a || !b) continue;
        let score = 0;
        if (a === b) score = 1;
        else if (a.includes(b) || b.includes(a)) score = 0.85;
        else {
          const prefixLen = Math.min(16, a.length, b.length);
          if (prefixLen >= 4 && a.slice(0, prefixLen) === b.slice(0, prefixLen)) score = 0.75;
        }
        if (score > bestScore) {
          bestScore = score;
          best = r;
        }
      }
      hit = best;
    }
    if (!hit) continue;
    const key = hit.note_id || normPublishedTitleKey(hit.title);
    if (used.has(key)) continue;
    used.add(key);
    out.push({ ...hit, title: want });
  }
  return out;
}

function isTrustedExploreUrl(url?: string): boolean {
  if (!url?.trim()) return false;
  if (isRejectedNoteUrl(url)) return false;
  if (!url.includes("/explore/")) return false;
  if (url.includes("xsec_token")) return true;
  if (/xsec_source=pc_creatormng/.test(url) && !url.includes("xsec_token")) return false;
  return false;
}

async function closeRejectedExploreTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: "https://www.xiaohongshu.com/*" });
  for (const t of tabs) {
    const u = (t.pendingUrl || t.url || "").trim();
    if (t.id != null && isRejectedNoteUrl(u)) {
      await chrome.tabs.remove(t.id).catch(() => undefined);
    }
  }
}

async function focusManagerTab(tabId: number): Promise<void> {
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (t.windowId != null) {
      await chrome.windows.update(t.windowId, { focused: true });
    }
  } catch {
    /* ignore */
  }
}

/** 仅通过笔记管理页点击封面抓链接（不拼接 explore URL） */
async function resolveOfficialExploreUrl(
  managerTabId: number,
  row: CreatorLinkRow
): Promise<string | undefined> {
  if (isTrustedExploreUrl(row.official_url)) return row.official_url;

  await focusManagerTab(managerTabId);
  const viaClick = await clickCoverAndCaptureUrl(managerTabId, row.title, row.note_id);
  await closeRejectedExploreTabs();
  if (viaClick && isTrustedExploreUrl(viaClick)) return viaClick;
  return undefined;
}

async function updateCreatorScrapeJobProgress(
  jobId: string | undefined,
  progress: { phase: string; current: number; total: number }
): Promise<void> {
  if (!jobId) return;
  const key = creatorScrapeJobKey(jobId);
  try {
    const data = await chrome.storage.session.get(key);
    const prev = (data[key] && typeof data[key] === "object" ? data[key] : {}) as Record<
      string,
      unknown
    >;
    if (prev.status !== "running") return;
    await chrome.storage.session.set({ [key]: { ...prev, progress } });
  } catch {
    /* ignore */
  }
}

async function enrichLinkRowsWithExploreUrls(
  rows: CreatorLinkRow[],
  managerTabId: number,
  maxResolve = 24,
  jobId?: string
): Promise<void> {
  const need = rows.filter((r) => !isTrustedExploreUrl(r.official_url));
  let budget = Math.min(maxResolve, need.length);
  let current = 0;
  for (const row of rows) {
    if (budget <= 0) break;
    if (isTrustedExploreUrl(row.official_url)) continue;
    row.official_url = undefined;
    current += 1;
    await updateCreatorScrapeJobProgress(jobId, {
      phase: "click_cover",
      current,
      total: need.length
    });

    const resolved = await resolveOfficialExploreUrl(managerTabId, row);
    budget -= 1;
    if (resolved) row.official_url = resolved;
    await focusManagerTab(managerTabId);
    await sleepMs(400);
  }
}

function mergeCreatorPublishedWithLinks(
  metrics: Array<Record<string, unknown>>,
  links: CreatorLinkRow[]
): Array<Record<string, unknown>> {
  const linkByTitle = new Map<string, CreatorLinkRow>();
  for (const l of links) {
    if (!l.title) continue;
    linkByTitle.set(normPublishedTitleKey(l.title), l);
  }
  const used = new Set<string>();
  const merged = metrics.map((raw) => {
    const title = typeof raw.title === "string" ? raw.title : "";
    const key = normPublishedTitleKey(title);
    const link = linkByTitle.get(key);
    if (!link) return raw;
    used.add(key);
    return {
      ...raw,
      official_url:
        (typeof raw.official_url === "string" && raw.official_url.trim()) ||
        (link.official_url?.trim() || undefined),
      cover_url: (typeof raw.cover_url === "string" && raw.cover_url) || link.cover_url,
      published_at:
        (typeof raw.published_at === "string" && raw.published_at) || link.published_at
    };
  });
  for (const link of links) {
    const key = normPublishedTitleKey(link.title);
    if (used.has(key)) continue;
    if (merged.some((m) => normPublishedTitleKey(String(m.title || "")) === key)) continue;
    merged.push({
      title: link.title,
      official_url: link.official_url,
      published_at: link.published_at,
      cover_url: link.cover_url,
      publish_status: link.publish_status || "published",
      watch_count: link.watch_count,
      likes: link.likes,
      comments: link.comments,
      favorites: link.favorites,
      shares: link.shares
    });
  }
  return merged;
}

function creatorScrapeJobKey(jobId: string): string {
  return `creator_scrape_job_${jobId}`;
}

function sendContentMessage(tabId: number, msg: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("content_message_timeout")), timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError?.message;
      if (err) reject(new Error(err));
      else resolve(resp);
    });
  });
}

/** 在页面 MAIN 环境点封面（与 content 同源选择器思路，避免仅依赖 ISOLATED content） */
async function clickNoteCoverInMainWorld(
  tabId: number,
  title: string,
  noteId?: string
): Promise<boolean> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (wantTitle: string, wantNoteId: string) => {
      const norm = (s: string) =>
        String(s || "")
          .replace(/\s+/g, "")
          .toLowerCase()
          .replace(/^未通过/, "");
      const want = norm(wantTitle);
      const idWant = (wantNoteId || "").trim().toLowerCase();

      function noteIdFromAttr(raw: string): string {
        if (!raw) return "";
        const m =
          raw.match(/"noteId"\s*:\s*"([a-f0-9]{16,})"/i) ||
          raw.match(/"note_id"\s*:\s*"([a-f0-9]{16,})"/i);
        return m ? String(m[1]).toLowerCase() : "";
      }

      function clickCoverInCard(card: HTMLElement): boolean {
        const sels = [
          "div.img",
          "motion-div.img",
          ".note div.img",
          "[class*='cover'] img",
          ".img img",
          "a[href*='/explore/']",
          "img"
        ];
        for (const sel of sels) {
          const el = card.querySelector(sel);
          if (el instanceof HTMLElement) {
            const r = el.getBoundingClientRect();
            if (r.width > 2 && r.height > 2) {
              el.click();
              return true;
            }
          }
        }
        if (card.offsetWidth > 0) {
          card.click();
          return true;
        }
        return false;
      }

      const tried = new Set<HTMLElement>();

      for (const el of document.querySelectorAll<HTMLElement>("[data-impression]")) {
        const raw = el.getAttribute("data-impression") || "";
        if (!raw.includes("note") && !/noteId/i.test(raw)) continue;
        const nid = noteIdFromAttr(raw);
        if (idWant && nid && nid !== idWant) continue;

        const card =
          el.closest<HTMLElement>(".note") ||
          el.closest<HTMLElement>("motion-div.note") ||
          el.closest<HTMLElement>("[class*='note']") ||
          el;
        if (tried.has(card)) continue;

        if (want.length >= 4) {
          const titleEl = card.querySelector<HTMLElement>(".title, [class*='title']");
          const blob = ((titleEl && titleEl.textContent) || card.innerText || "").trim();
          const got = norm(blob);
          const prefix = want.slice(0, Math.min(18, want.length));
          if (got && prefix && !got.includes(prefix) && !want.includes(got.slice(0, Math.min(18, got.length)))) {
            if (!idWant || !nid) continue;
          }
        }

        tried.add(card);
        if (clickCoverInCard(card)) return true;
      }

      for (const card of document.querySelectorAll<HTMLElement>(
        ".note, motion-div.note, motion-div[class*='note']"
      )) {
        if (tried.has(card)) continue;
        const raw =
          card.getAttribute("data-impression") ||
          card.querySelector<HTMLElement>("[data-impression]")?.getAttribute("data-impression") ||
          "";
        const nid = noteIdFromAttr(raw);
        if (idWant && nid && nid !== idWant) continue;
        if (want.length >= 4) {
          const titleEl = card.querySelector<HTMLElement>(".title, [class*='title']");
          const got = norm((titleEl && titleEl.textContent) || card.innerText || "");
          const prefix = want.slice(0, Math.min(18, want.length));
          if (got && prefix && !got.includes(prefix) && !want.includes(got.slice(0, Math.min(18, got.length)))) {
            if (!idWant) continue;
          }
        }
        tried.add(card);
        if (clickCoverInCard(card)) return true;
      }

      return false;
    },
    args: [title, noteId || ""]
  });
  return Boolean(result?.result);
}

/** 诊断：脚本能否在笔记管理页点到封面并打开 explore（供 DEBUG 与排查） */
async function probeNoteManagerScriptClick(tabId: number): Promise<Record<string, unknown>> {
  let domRows = 0;
  let domNotes = 0;
  try {
    const domResp = (await sendContentMessage(
      tabId,
      { channel: "XHS_PUBLISH_BRIDGE", action: "DEBUG_NOTE_MANAGER_DOM" },
      8000
    )) as Record<string, unknown> | null;
    domRows = Number(domResp?.rows) || 0;
    domNotes = Number(domResp?.notes) || 0;
  } catch (e) {
    return { ok: false, error: "content_unreachable", detail: String(e) };
  }

  const tabsBefore = await chrome.tabs.query({ url: "https://www.xiaohongshu.com/*" });
  const exploreBefore = tabsBefore.filter((t) => (t.url || "").includes("/explore/")).length;

  let mainClick: Record<string, unknown> = { clicked: false };
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const cards = document.querySelectorAll<HTMLElement>(
          ".note, motion-div.note, motion-div[class*='note']"
        );
        for (const card of cards) {
          const sels = ["motion-div.img", "motion-div.img img", "div.img", ".img img", "img"];
          for (const sel of sels) {
            const el = card.querySelector<HTMLElement>(sel);
            if (el && el.offsetWidth > 2) {
              el.click();
              return {
                clicked: true,
                cardCount: cards.length,
                selector: sel,
                rect: { w: el.offsetWidth, h: el.offsetHeight }
              };
            }
          }
        }
        return { clicked: false, cardCount: cards.length, selector: null };
      }
    });
    mainClick = (r?.result as Record<string, unknown>) || { clicked: false };
  } catch (e) {
    mainClick = { clicked: false, error: String(e) };
  }

  await sleepMs(2800);
  const tabsAfter = await chrome.tabs.query({ url: "https://www.xiaohongshu.com/*" });
  const exploreAfter = tabsAfter.filter((t) => {
    const u = (t.url || "").trim();
    return u.includes("/explore/") && !isRejectedNoteUrl(u);
  });

  let verdict = "unknown";
  if (exploreAfter.length > exploreBefore) verdict = "script_click_opens_tab";
  else if (mainClick.clicked && exploreAfter.length === exploreBefore)
    verdict = "click_fired_but_no_new_tab";
  else if (!mainClick.clicked) verdict = "no_cover_element_found";
  else verdict = "no_explore_tab";

  return {
    ok: true,
    verdict,
    domRows,
    domNotes,
    mainClick,
    exploreTabsBefore: exploreBefore,
    exploreTabsAfter: exploreAfter.length,
    exploreUrlSample: exploreAfter[0]?.url,
    hint:
      verdict === "click_fired_but_no_new_tab"
        ? "脚本 click 已执行但未开新标签：可能被站点拦截（需真实鼠标点击）或弹窗被拦"
        : verdict === "no_cover_element_found"
          ? "未找到可点封面：请切到「全部笔记」并滚动列表"
          : verdict === "script_click_opens_tab"
            ? "脚本点击可开新标签，补全失败更可能是标题未匹配或扩展未连上该 Tab"
            : "请用鼠标手动点一次封面对比"
  };
}

/** 先监听新标签，再 MAIN 点封面，再 content 兜底（避免 capture 晚于点击） */
async function clickCoverAndCaptureUrl(
  tabId: number,
  title: string,
  noteId?: string
): Promise<string | undefined> {
  await ensureCreatorContentScript(tabId);
  bridgeLog("clickCover start", { tabId, title: title.slice(0, 24), noteId });

  const tryOnce = async (): Promise<string | undefined> => {
    const capturePromise = beginExploreCapture(14000, { watchTabId: tabId });
    let mainOk = false;
    try {
      mainOk = await clickNoteCoverInMainWorld(tabId, title, noteId);
    } catch (e) {
      bridgeLog("MAIN click inject error", String(e));
    }
    await sleepMs(mainOk ? 400 : 150);
    let got = await capturePromise;
    await closeRejectedExploreTabs();
    if (got && isTrustedExploreUrl(got)) return got;
    got = await pollExploreUrlAfterClick(tabId, undefined, mainOk ? 4500 : 2500);
    await closeRejectedExploreTabs();
    if (got && isTrustedExploreUrl(got)) return got;
    return undefined;
  };

  let url = await tryOnce();
  bridgeLog("tryOnce", { mainPath: Boolean(url) });
  if (url) return url;

  try {
    const resp = (await sendContentMessage(
      tabId,
      {
        channel: "XHS_PUBLISH_BRIDGE",
        action: "CLICK_NOTE_COVER_AND_CAPTURE",
        payload: { title, note_id: noteId }
      },
      20000
    )) as { ok?: boolean; official_url?: string; detail?: string } | null;
    const u = typeof resp?.official_url === "string" ? resp.official_url.trim() : "";
    bridgeLog("content capture", { ok: resp?.ok, detail: resp?.detail, hasUrl: Boolean(u) });
    if (u && isTrustedExploreUrl(u)) return u;
  } catch (e) {
    bridgeLog("content capture error", String(e));
  }

  url = await tryOnce();
  await closeRejectedExploreTabs();
  bridgeLog("clickCover end", { success: Boolean(url && isTrustedExploreUrl(url)) });
  return url && isTrustedExploreUrl(url) ? url : undefined;
}

function mapLinkRowsFromDom(items: unknown[]): CreatorLinkRow[] {
  return items
    .filter((x) => x && typeof x === "object")
    .map((x) => x as Record<string, unknown>)
    .map((x) => ({
      title: typeof x.title === "string" ? x.title : "",
      note_id:
        typeof x.note_id === "string" && /^[a-f0-9]{16,}$/i.test(x.note_id)
          ? x.note_id.toLowerCase()
          : extractNoteIdFromUrl(typeof x.official_url === "string" ? x.official_url : undefined),
      official_url:
        typeof x.official_url === "string" && x.official_url.trim()
          ? x.official_url.trim()
          : undefined,
      published_at: typeof x.published_at === "string" ? x.published_at : undefined,
      cover_url: typeof x.cover_url === "string" ? x.cover_url : undefined,
      publish_status: typeof x.publish_status === "string" ? x.publish_status : undefined,
      watch_count: typeof x.watch_count === "number" ? x.watch_count : undefined,
      likes: typeof x.likes === "number" ? x.likes : undefined,
      comments: typeof x.comments === "number" ? x.comments : undefined,
      favorites: typeof x.favorites === "number" ? x.favorites : undefined,
      shares: typeof x.shares === "number" ? x.shares : undefined
    }))
    .filter((x) => x.title) as CreatorLinkRow[];
}

function mapScrapeOutputItems(
  mergedRaw: Array<Record<string, unknown>>,
  limit: number
): ScrapeCreatorPublishedResult["items"] {
  return mergedRaw
    .map((x) => ({
      title: typeof x.title === "string" ? x.title : "",
      published_at: typeof x.published_at === "string" ? x.published_at : undefined,
      publish_status: typeof x.publish_status === "string" ? x.publish_status : undefined,
      cover_url: typeof x.cover_url === "string" ? x.cover_url : undefined,
      official_url: typeof x.official_url === "string" ? x.official_url : undefined,
      impressions: typeof x.impressions === "number" ? x.impressions : undefined,
      watch_count: typeof x.watch_count === "number" ? x.watch_count : undefined,
      click_rate_pct: typeof x.click_rate_pct === "number" ? x.click_rate_pct : undefined,
      likes: typeof x.likes === "number" ? x.likes : undefined,
      comments: typeof x.comments === "number" ? x.comments : undefined,
      favorites: typeof x.favorites === "number" ? x.favorites : undefined,
      follower_gain: typeof x.follower_gain === "number" ? x.follower_gain : undefined,
      shares: typeof x.shares === "number" ? x.shares : undefined,
      avg_watch_seconds: typeof x.avg_watch_seconds === "number" ? x.avg_watch_seconds : undefined
    }))
    .filter((x) => x.title)
    .slice(0, limit);
}

/** 在页面 MAIN 世界拦截创作中心自带的 posted 请求（含 x-s 签名，隔离环境 fetch 会 403） */
async function injectPostedApiCaptureMain(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        type CaptureState = {
          payloads: unknown[];
          byPage: Record<string, unknown>;
          installed: boolean;
        };
        const w = window as Window & { __xhsPostedCapture?: CaptureState };
        if (w.__xhsPostedCapture?.installed) return;
        const state: CaptureState = { payloads: [], byPage: {}, installed: true };
        w.__xhsPostedCapture = state;

        const syncPayloadList = () => {
          state.payloads = Object.keys(state.byPage)
            .sort((a, b) => Number(a) - Number(b))
            .map((k) => state.byPage[k]);
        };

        const remember = (text: string, url: string) => {
          if (!text || text.length < 40) return;
          const u = String(url || "");
          if (!u.includes("/api/galaxy/v2/creator/note/user/posted")) return;
          try {
            const json = JSON.parse(text) as { data?: { notes?: unknown[] }; code?: number };
            const notes = json?.data?.notes;
            if (Array.isArray(notes) && notes.length > 0) {
              const pageMatch = u.match(/[?&]page=(\d+)/);
              const pageKey = pageMatch ? pageMatch[1] : String(Object.keys(state.byPage).length);
              state.byPage[pageKey] = json;
              syncPayloadList();
            }
          } catch {
            /* ignore */
          }
        };

        const origFetch = window.fetch.bind(window);
        window.fetch = async (...args: Parameters<typeof fetch>) => {
          const reqUrl =
            typeof args[0] === "string"
              ? args[0]
              : args[0] instanceof Request
                ? args[0].url
                : String(args[0]);
          const res = await origFetch(...args);
          try {
            remember(await res.clone().text(), reqUrl);
          } catch {
            /* ignore */
          }
          return res;
        };

        const Xhr = XMLHttpRequest.prototype;
        const origOpen = Xhr.open;
        const origSend = Xhr.send;
        Xhr.open = function (method: string, url: string | URL, ...rest: unknown[]) {
          (this as XMLHttpRequest & { __xhsUrl?: string }).__xhsUrl = String(url);
          return origOpen.apply(this, [method, url, ...rest] as never);
        };
        Xhr.send = function (...args: unknown[]) {
          this.addEventListener("load", function () {
            try {
              const xhrUrl = (this as XMLHttpRequest & { __xhsUrl?: string }).__xhsUrl || "";
              const body = (this as XMLHttpRequest).responseText;
              if (typeof body === "string") remember(body, xhrUrl);
            } catch {
              /* ignore */
            }
          });
          return origSend.apply(this, args as never);
        };
      }
    });
  } catch (e) {
    bridgeLog("injectPostedApiCaptureMain failed", String(e));
  }
}

async function readPostedApiCaptureMain(tabId: number): Promise<unknown[]> {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const w = window as Window & { __xhsPostedCapture?: { payloads: unknown[] } };
        const list = w.__xhsPostedCapture?.payloads;
        return Array.isArray(list) ? [...list] : [];
      }
    });
    return Array.isArray(r?.result) ? (r.result as unknown[]) : [];
  } catch {
    return [];
  }
}

async function postedCaptureNeedsMorePages(
  tabId: number,
  payloads: unknown[]
): Promise<boolean> {
  try {
    const res = (await sendContentMessage(
      tabId,
      {
        channel: "XHS_PUBLISH_BRIDGE",
        action: "POSTED_API_STATS",
        payload: { mainPayloads: payloads }
      },
      8000
    )) as { needsMore?: boolean } | null;
    return Boolean(res?.needsMore);
  } catch {
    return false;
  }
}

async function scrollNoteManagerForMorePosted(tabId: number): Promise<void> {
  try {
    await sendContentMessage(
      tabId,
      { channel: "XHS_PUBLISH_BRIDGE", action: "SCROLL_POSTED_LIST" },
      15000
    );
  } catch {
    /* ignore */
  }
  await sleepMs(2200);
}

/** 注入 MAIN 拦截器并等待页面自带 posted 请求完成（含 page=1+ 分页） */
async function collectPostedApiPayloadsFromPage(tabId: number): Promise<unknown[]> {
  await injectPostedApiCaptureMain(tabId);

  let payloads = await readPostedApiCaptureMain(tabId);

  const prepare = async (loadAllPages: boolean) => {
    try {
      await sendContentMessage(
        tabId,
        {
          channel: "XHS_PUBLISH_BRIDGE",
          action: "PREPARE_POSTED_API",
          payload: { loadAllPages }
        },
        22000
      );
    } catch {
      /* ignore */
    }
    await sleepMs(loadAllPages ? 3200 : 2400);
  };

  if (!payloads.length) {
    await prepare(true);
    payloads = await readPostedApiCaptureMain(tabId);
  }

  if (!payloads.length) {
    bridgeLog("reload note-manager to capture signed posted API");
    await chrome.tabs.update(tabId, { url: CREATOR_NOTE_MANAGER_URL });
    await waitTabComplete(tabId, 35000, {
      ignoreImmediateComplete: true,
      expectedUrlPrefix: "https://creator.xiaohongshu.com/"
    });
    await injectPostedApiCaptureMain(tabId);
    await sleepMs(3500);
    await prepare(true);
    payloads = await readPostedApiCaptureMain(tabId);
    bridgeLog("posted capture after reload", { count: payloads.length });
  }

  for (let round = 0; round < 8 && (await postedCaptureNeedsMorePages(tabId, payloads)); round += 1) {
    bridgeLog("posted API needs more pages, scroll round", round + 1);
    await scrollNoteManagerForMorePosted(tabId);
    payloads = await readPostedApiCaptureMain(tabId);
  }

  bridgeLog("posted capture done", { pages: payloads.length });
  return payloads;
}

async function ensureCreatorContentScript(tabId: number): Promise<void> {
  try {
    await sendContentMessage(
      tabId,
      { channel: "XHS_PUBLISH_BRIDGE", action: "PING_CONTENT" },
      2500
    );
    return;
  } catch {
    /* 未注入，下面补注入一次 */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await sleepMs(400);
  } catch {
    /* 已注入或页面不可用 */
  }
}

/** 点封面前：切到「全部笔记」并滚动列表，便于按标题找到卡片 */
async function prepareNoteManagerForCoverClicks(tabId: number): Promise<void> {
  try {
    await ensureCreatorContentScript(tabId);
    await sendContentMessage(
      tabId,
      {
        channel: "XHS_PUBLISH_BRIDGE",
        action: "PREPARE_NOTE_MANAGER_FOR_CLICKS"
      },
      18000
    );
  } catch {
    /* 页面未就绪时 enrich 仍会逐条尝试 */
  }
}

/** 从创作中心 posted 接口拉取笔记（含 xsec_token 的 explore 链接） */
async function fetchLinkRowsFromPostedApi(
  tabId: number,
  limit: number,
  matchTitles?: string[]
): Promise<{
  linkRows: CreatorLinkRow[];
  meta?: {
    linksFound?: number;
    source?: string;
    pages?: number;
    apiError?: string;
    apiTotal?: number;
    apiTotalWithLink?: number;
  };
}> {
  await ensureCreatorContentScript(tabId);
  const need = Math.max(limit, matchTitles?.length ?? 0, 20);
  try {
    const mainPayloads = await collectPostedApiPayloadsFromPage(tabId);

    const res = (await sendContentMessage(
      tabId,
      {
        channel: "XHS_PUBLISH_BRIDGE",
        action: "FETCH_CREATOR_POSTED_NOTES",
        payload: {
          limit: Math.min(200, need + 20),
          tab: 0,
          mainPayloads
        }
      },
      90000
    )) as Record<string, unknown> | null;

    if (!res?.ok || !Array.isArray(res.items)) {
      return {
        linkRows: [],
        meta: {
          source: "posted_api",
          apiError:
            typeof res?.error === "string"
              ? String(res.error)
              : typeof res?.detail === "string"
                ? String(res.detail)
                : "posted_api_failed"
        }
      };
    }

    const allRows = mapLinkRowsFromDom(res.items as unknown[]);
    const apiTotalWithLink = allRows.filter((r) => isTrustedExploreUrl(r.official_url)).length;
    const linkRows = matchTitles?.length
      ? filterLinkRowsByMatchTitles(allRows, matchTitles)
      : allRows.slice(0, limit);
    const meta = res.meta && typeof res.meta === "object" ? (res.meta as Record<string, unknown>) : {};
    const apiError =
      typeof meta.apiError === "string"
        ? meta.apiError
        : typeof res.apiError === "string"
          ? String(res.apiError)
          : undefined;
    bridgeLog("posted API", {
      rows: linkRows.length,
      apiTotal: allRows.length,
      apiTotalWithLink,
      links: linkRows.filter((r) => isTrustedExploreUrl(r.official_url)).length,
      pages: res.pages,
      source: meta.source
    });
    return {
      linkRows,
      meta: {
        linksFound: linkRows.filter((r) => isTrustedExploreUrl(r.official_url)).length,
        source: typeof meta.source === "string" ? meta.source : "posted_api",
        pages: typeof res.pages === "number" ? res.pages : undefined,
        apiError,
        apiTotal: allRows.length,
        apiTotalWithLink
      }
    };
  } catch (e) {
    bridgeLog("posted API error", String(e));
    return { linkRows: [], meta: { source: "posted_api", apiError: String(e) } };
  }
}

async function scrapeNoteManagerLinkRows(
  tabId: number,
  limit: number,
  matchTitles?: string[]
): Promise<{
  linkRows: CreatorLinkRow[];
  meta?: {
    rowsFound?: number;
    linksFound?: number;
    domRows?: number;
    impressionNodes?: number;
    impressionWithTitle?: number;
    matchTitlesRequested?: number;
  };
}> {
  const sendScrape = async () => {
    try {
      return await sendContentMessage(
        tabId,
        {
          channel: "XHS_PUBLISH_BRIDGE",
          action: "SCRAPE_CREATOR_NOTE_MANAGER_DOM",
          payload: { limit, catalogOnly: true, matchTitles }
        },
        25000
      );
    } catch {
      await ensureCreatorContentScript(tabId);
      return await sendContentMessage(
        tabId,
        {
          channel: "XHS_PUBLISH_BRIDGE",
          action: "SCRAPE_CREATOR_NOTE_MANAGER_DOM",
          payload: { limit, catalogOnly: true, matchTitles }
        },
        25000
      );
    }
  };

  let linkRes = await sendScrape();
  let linkObj = (linkRes && typeof linkRes === "object" ? (linkRes as Record<string, unknown>) : null) || null;
  if (!linkObj?.ok || !Array.isArray(linkObj.items) || (linkObj.items as unknown[]).length === 0) {
    await new Promise((r) => setTimeout(r, 2500));
    linkRes = await sendScrape();
    linkObj = (linkRes && typeof linkRes === "object" ? (linkRes as Record<string, unknown>) : null) || null;
  }
  let linkRows: CreatorLinkRow[] = [];
  if (linkObj?.ok && Array.isArray(linkObj.items)) {
    linkRows = mapLinkRowsFromDom(linkObj.items as unknown[]);
  }
  const meta =
    linkObj?.meta && typeof linkObj.meta === "object"
      ? (linkObj.meta as { rowsFound?: number; linksFound?: number })
      : undefined;
  return { linkRows, meta };
}

async function runCreatorNoteManagerLinksOnly(
  limit: number,
  matchTitles?: string[],
  jobId?: string
): Promise<ScrapeCreatorPublishedResult> {
  const { tabId, reusedAndNavigated } = await ensureCreatorNoteManagerTab();
  await waitTabComplete(tabId, 30000, {
    ignoreImmediateComplete: reusedAndNavigated,
    expectedUrlPrefix: "https://creator.xiaohongshu.com/"
  });
  await new Promise((r) => setTimeout(r, reusedAndNavigated ? 1200 : 2200));

  await updateCreatorScrapeJobProgress(jobId, {
    phase: "posted_api",
    current: 0,
    total: matchTitles?.length ?? 0
  });

  let linkRows: CreatorLinkRow[] = [];
  let meta: Record<string, unknown> = {};
  const apiResult = await fetchLinkRowsFromPostedApi(tabId, limit, matchTitles);
  linkRows = apiResult.linkRows;
  meta = { ...(apiResult.meta || {}), matchTitlesRequested: matchTitles?.length ?? 0 };

  const apiLinks = linkRows.filter((r) => isTrustedExploreUrl(r.official_url)).length;
  const apiTotalWithLink = Number(meta.apiTotalWithLink) || 0;
  const apiTotal = Number(meta.apiTotal) || 0;
  const apiErr = typeof meta.apiError === "string" ? meta.apiError : "";

  if (!linkRows.length || (matchTitles?.length && apiLinks === 0)) {
    if (apiTotalWithLink > 0 && matchTitles?.length) {
      return {
        ok: false,
        error: "title_match_failed",
        detail: `创作中心接口已返回 ${apiTotalWithLink} 条带链接笔记，但与运营台 ${matchTitles.length} 个标题未匹配上。请核对标题是否一致`,
        tabId
      };
    }
    if (!apiTotal) {
      return {
        ok: false,
        error: "note_manager_empty",
        detail: apiErr
          ? `posted 接口失败：${apiErr}。请在创作中心笔记管理页按 F5 刷新后重试（扩展 v0.5.3+）`
          : "未拦截到 posted 接口数据。请打开创作中心「笔记管理」、登录后刷新页面再点补全",
        tabId
      };
    }
    return {
      ok: false,
      error: "no_explore_links",
      detail: apiErr
        ? `posted 接口异常：${apiErr}`
        : `接口返回 ${apiTotal} 条笔记但无 xsec_token 链接。请重新加载扩展 v0.5.2+ 后在笔记管理页重试`,
      tabId
    };
  }

  const withLink = linkRows.filter((r) => isTrustedExploreUrl(r.official_url)).length;
  if (matchTitles?.length && withLink === 0) {
    return {
      ok: false,
      error: "no_explore_links",
      detail: "未解析到带 xsec_token 的 explore 链接",
      tabId
    };
  }

  return {
    ok: true,
    items: mapScrapeOutputItems(
      linkRows
        .filter((r) => !matchTitles?.length || isTrustedExploreUrl(r.official_url))
        .map((x) => ({ ...x })) as Array<Record<string, unknown>>,
      limit
    ),
    tabId,
    linksFound: withLink
  } as ScrapeCreatorPublishedResult & { linksFound?: number };
}

async function runCreatorPublishedScrape(limit: number): Promise<ScrapeCreatorPublishedResult> {
  const { tabId, reusedAndNavigated } = await ensureCreatorNoteManagerTab();
  await waitTabComplete(tabId, 30000, {
    ignoreImmediateComplete: reusedAndNavigated,
    expectedUrlPrefix: "https://creator.xiaohongshu.com/"
  });
  await new Promise((r) => setTimeout(r, reusedAndNavigated ? 1200 : 2200));

  const apiResult = await fetchLinkRowsFromPostedApi(tabId, limit);
  let linkRows = apiResult.linkRows;
  if (!linkRows.length) {
    const domResult = await scrapeNoteManagerLinkRows(tabId, limit);
    linkRows = domResult.linkRows;
  }

  let mergedRaw: Array<Record<string, unknown>> = linkRows.map((x) => ({ ...x }));

  await chrome.tabs.update(tabId, { url: CREATOR_ANALYTICS_URL, active: true });
  await waitTabComplete(tabId, 30000, {
    ignoreImmediateComplete: true,
    expectedUrlPrefix: "https://creator.xiaohongshu.com/"
  });
  await new Promise((r) => setTimeout(r, 2200));

  const res = (await chrome.tabs.sendMessage(tabId, {
    channel: "XHS_PUBLISH_BRIDGE" as const,
    action: "SCRAPE_CREATOR_ANALYTICS_DOM" as const,
    payload: { limit }
  })) as unknown;
  const obj = (res && typeof res === "object" ? (res as Record<string, unknown>) : null) || null;
  const ok = Boolean(obj && obj.ok);
  if (obj?.ok && Array.isArray(obj.items)) {
    const metrics = (obj.items as unknown[])
      .filter((x) => x && typeof x === "object")
      .map((x) => x as Record<string, unknown>);
    mergedRaw = mergeCreatorPublishedWithLinks(metrics, linkRows);
  } else if (!ok && mergedRaw.length === 0) {
    return {
      ok: false,
      error: typeof obj?.error === "string" ? String(obj.error) : "scrape_failed",
      detail: typeof obj?.detail === "string" ? String(obj.detail) : undefined,
      tabId
    };
  }

  const items = mapScrapeOutputItems(mergedRaw, limit);
  const linksFound = items.filter((x) => isTrustedExploreUrl(x.official_url)).length;
  return { ok: true, items, tabId, linksFound } as ScrapeCreatorPublishedResult & {
    linksFound?: number;
  };
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
      void chrome.tabs
        .get(tabId)
        .then((tab) => {
          const okUrl = !expected || (tab.url || "").startsWith(expected);
          if (okUrl && tab.status === "complete") {
            clearTimeout(t);
            chrome.tabs.onUpdated.removeListener(onUpd);
            resolve();
          }
        })
        .catch(() => undefined);
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
  const maxAttempts = 10;
  const delayMs = 500;
  let last: FillResult = { ok: false, detail: "no_content_response" };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs));
    else await new Promise((r) => setTimeout(r, 400));
    const imageUploaded = Boolean(last.filled?.image_upload);
    const msg = {
      channel: "XHS_PUBLISH_BRIDGE" as const,
      action: "FILL_DOM" as const,
      payload:
        attempt === 0 || !imageUploaded
          ? { title, body, firstImageUrl, imageUrls }
          : { title, body, skipImageUpload: true as const }
    };
    try {
      const res = (await chrome.tabs.sendMessage(tabId, msg)) as FillResult | undefined;
      last = res || { ok: false, detail: "no_content_response" };
      if (last.ok) return last;
      if (imageUploaded) continue;
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
  return last;
}

function startCreatorScrapeJob(
  jobId: string,
  runner: () => Promise<ScrapeCreatorPublishedResult>,
  meta?: { matchTitlesCount?: number }
) {
  const key = creatorScrapeJobKey(jobId);
  void chrome.storage.session.set({
    [key]: {
      status: "running",
      startedAt: Date.now(),
      matchTitlesCount: meta?.matchTitlesCount ?? 0
    }
  });
  void (async () => {
    try {
      const result = await runner();
      await chrome.storage.session.set({ [key]: { status: "done", result } });
    } catch (e) {
      await chrome.storage.session.set({
        [key]: { status: "error", error: "scrape_exception", detail: String(e) }
      });
    }
  })();
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isBridgeMessage(message)) {
    return false;
  }
  if (message.action === "PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return;
  }
  if (message.action === "DEBUG_NOTE_MANAGER_PROBE") {
    void (async () => {
      try {
        const { tabId } = await ensureCreatorNoteManagerTab();
        await waitTabComplete(tabId, 25000, {
          expectedUrlPrefix: "https://creator.xiaohongshu.com/"
        });
        await sleepMs(1500);
        await ensureCreatorContentScript(tabId);
        const report = await probeNoteManagerScriptClick(tabId);
        bridgeLog("DEBUG_NOTE_MANAGER_PROBE", report);
        sendResponse(report);
      } catch (e) {
        sendResponse({ ok: false, error: "probe_failed", detail: String(e) });
      }
    })();
    return true;
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
  if (message.action === "SCRAPE_CREATOR_PUBLISHED_POLL") {
    void (async () => {
      const jobId = String((message.payload as { jobId?: string } | undefined)?.jobId || "").trim();
      if (!jobId) {
        sendResponse({ status: "unknown" });
        return;
      }
      const key = creatorScrapeJobKey(jobId);
      const data = await chrome.storage.session.get(key);
      sendResponse(data[key] || { status: "unknown" });
    })();
    return true;
  }
  if (message.action === "SCRAPE_CREATOR_NOTE_LINKS") {
    const payload = (message.payload as { limit?: number; matchTitles?: string[] } | undefined) || {};
    const limitRaw = Number(payload.limit ?? 80);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 80;
    const matchTitles = Array.isArray(payload.matchTitles)
      ? payload.matchTitles.map((t) => String(t).trim()).filter((t) => t.length >= 2)
      : undefined;
    const jobId = `cl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    sendResponse({ ok: true, pending: true, jobId });
    startCreatorScrapeJob(
      jobId,
      () => runCreatorNoteManagerLinksOnly(limit, matchTitles, jobId),
      { matchTitlesCount: matchTitles?.length ?? 0 }
    );
    return true;
  }
  if (message.action === "SCRAPE_CREATOR_PUBLISHED") {
    const limitRaw = Number((message.payload as { limit?: number } | undefined)?.limit ?? 80);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 80;
    const jobId = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    sendResponse({ ok: true, pending: true, jobId });
    startCreatorScrapeJob(jobId, () => runCreatorPublishedScrape(limit));
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
