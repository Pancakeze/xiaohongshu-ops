/**
 * 在 creator.xiaohongshu.com：切到「上传图文」→ 必要时程序化上传首张图（平台要求有图才出标题/正文）→ 填写标题与正文。
 */
import type { FillResult } from "./types";

const TITLE_SELECTORS = [
  'input[placeholder*="填写标题"]',
  'input[placeholder*="标题"]',
  'textarea[placeholder*="标题"]',
  '[data-placeholder*="标题"]',
  'input[aria-label*="标题"]',
  ".title-input input",
  ".note-editor input[type=text]"
];

const BODY_SELECTORS = [
  'textarea[placeholder*="输入正文"]',
  'textarea[placeholder*="正文"]',
  'textarea[placeholder*="添加"]',
  'textarea[aria-label*="正文"]',
  ".note-editor textarea",
  '[contenteditable="true"]'
];

/** 1×1 PNG，用于无首图 URL 时触发「已有图稿」状态 */
const PLACEHOLDER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type FetchImageResp = { ok?: boolean; base64?: string; mime?: string; error?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 含 open ShadowRoot（创作页常见），便于 querySelector 命中真实输入框 */
function allRootsBfs(): (Document | ShadowRoot)[] {
  const out: (Document | ShadowRoot)[] = [];
  const queue: (Document | ShadowRoot)[] = [document];
  const seen = new WeakSet<Document | ShadowRoot>();
  while (queue.length) {
    const r = queue.shift()!;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
    r.querySelectorAll("*").forEach((n) => {
      if (n instanceof HTMLElement && n.shadowRoot) queue.push(n.shadowRoot);
    });
  }
  return out;
}

/**
 * 兼容 React/Vue 受控输入：直接改 .value 常不同步内部 state，后续请求会 400。
 * 使用原型上的 native setter，并派发 input/change。
 */
function setNativeInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus();
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  try {
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: value })
    );
  } catch {
    /* 个别环境 InputEvent 构造受限 */
  }
}

function trySelectors(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    for (const root of allRootsBfs()) {
      try {
        const el = root.querySelector(sel);
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
        if (el instanceof HTMLElement && el.isContentEditable) return el;
      } catch {
        /* invalid selector */
      }
    }
  }
  return null;
}

function hasPublishFormFields(): boolean {
  return trySelectors(TITLE_SELECTORS) != null || trySelectors(BODY_SELECTORS) != null;
}

function clickUploadImageTextTab(): boolean {
  for (const root of allRootsBfs()) {
    const prefer = root.querySelectorAll('button, [role="tab"], [role="button"]');
    for (const el of prefer) {
      if (!(el instanceof HTMLElement)) continue;
      const raw = el.textContent?.replace(/\s+/g, "") ?? "";
      if (raw.includes("上传图文")) {
        el.click();
        return true;
      }
    }
  }
  return false;
}

/**
 * 首屏「上传图片，或写文字生成图片」：file input 常延迟挂载，需先点红色「上传图片」
 * 才会出现可赋值的 input 或触发站内上传链路（与「上传图文」Tab 不同）。
 */
function normClickText(s: string): string {
  return s.replace(/\s+/g, "").trim();
}

function clickUploadImagePrimaryCta(): boolean {
  const buttons: HTMLElement[] = [];
  const fallback: HTMLElement[] = [];
  for (const root of allRootsBfs()) {
    root.querySelectorAll("button, [role='button']").forEach((el) => {
      if (el instanceof HTMLElement) buttons.push(el);
    });
    root.querySelectorAll("a, span, div").forEach((el) => {
      if (el instanceof HTMLElement) fallback.push(el);
    });
  }

  const tryList = (els: HTMLElement[]): boolean => {
    for (const el of els) {
      const raw = normClickText(el.textContent || "");
      if (!raw || raw.includes("上传图文")) continue;
      if (raw.includes("文字配图")) continue;
      if (raw === "上传图片") {
        el.click();
        return true;
      }
    }
    for (const el of els) {
      const raw = normClickText(el.textContent || "");
      if (!raw || raw.includes("上传图文")) continue;
      if (raw.includes("文字配图")) continue;
      if (raw.startsWith("上传图片") && raw.length <= 8) {
        el.click();
        return true;
      }
    }
    return false;
  };

  if (tryList(buttons)) return true;
  return tryList(fallback);
}

/** 点击与 file input 关联的 label（部分实现用 label 承接点击） */
function clickLabelForFileInput(): boolean {
  for (const root of allRootsBfs()) {
    for (const lab of root.querySelectorAll("label[for]")) {
      if (!(lab instanceof HTMLElement)) continue;
      const fid = lab.getAttribute("for");
      if (!fid) continue;
      const target = root.querySelector(`#${CSS.escape(fid)}`);
      if (target instanceof HTMLInputElement && target.type === "file") {
        lab.click();
        return true;
      }
    }
  }
  return false;
}

function setContentEditable(el: HTMLElement, text: string): void {
  el.focus();
  if (typeof document.execCommand === "function") {
    try {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
    } catch {
      el.innerText = text;
    }
  } else {
    el.innerText = text;
  }
  try {
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text })
    );
  } catch {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillDom(title: string, body: string): FillResult {
  let titleOk = false;
  let bodyOk = false;

  const titleEl = trySelectors(TITLE_SELECTORS);
  if (titleEl) {
    if (titleEl instanceof HTMLInputElement || titleEl instanceof HTMLTextAreaElement) {
      setNativeInputValue(titleEl, title);
      titleOk = true;
    } else if (titleEl.isContentEditable) {
      setContentEditable(titleEl, title);
      titleOk = true;
    }
  }

  const bodyEl = trySelectors(BODY_SELECTORS);
  if (bodyEl) {
    if (bodyEl instanceof HTMLTextAreaElement || bodyEl instanceof HTMLInputElement) {
      setNativeInputValue(bodyEl, body);
      bodyOk = true;
    } else if (bodyEl.isContentEditable) {
      setContentEditable(bodyEl, body);
      bodyOk = true;
    }
  }

  return {
    ok: titleOk || bodyOk,
    filled: { title: titleOk, body: bodyOk },
    detail: !titleOk && !bodyOk ? "no_matching_fields_update_selectors" : undefined
  };
}

function normNoteText(s: string): string {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

/** 读当前 DOM 里标题/正文（用于判断还需不需要再写，避免 observer 与 React 死循环） */
function readDomTitleBody(): { title: string; body: string } {
  let title = "";
  let body = "";
  const tel = trySelectors(TITLE_SELECTORS);
  const bel = trySelectors(BODY_SELECTORS);
  if (tel instanceof HTMLInputElement || tel instanceof HTMLTextAreaElement) title = tel.value;
  else if (tel instanceof HTMLElement && tel.isContentEditable) title = tel.innerText;
  if (bel instanceof HTMLInputElement || bel instanceof HTMLTextAreaElement) body = bel.value;
  else if (bel instanceof HTMLElement && bel.isContentEditable) body = bel.innerText;
  return { title, body };
}

function needsDomRefill(wantTitle: string, wantBody: string): boolean {
  if (!hasPublishFormFields()) return true;
  const got = readDomTitleBody();
  return (
    normNoteText(got.title) !== normNoteText(wantTitle) ||
    normNoteText(got.body) !== normNoteText(wantBody)
  );
}

/** 统计正文里 `#xxx` 形话题数量（运营台合并进 body 的话题） */
function countHashtagTopics(body: string): number {
  const m = body.match(/#[^\s#]+/g);
  return m ? m.length : 0;
}

/** 话题少时少做 observer 补写，减轻创作页压力 */
function observerCaps(body: string): { maxRefill: number; windowMs: number } {
  const n = countHashtagTopics(body);
  if (n <= 2) return { maxRefill: 2, windowMs: 20_000 };
  if (n <= 5) return { maxRefill: 5, windowMs: 36_000 };
  return { maxRefill: 10, windowMs: 48_000 };
}

/**
 * 仅在「子树结构变化」时补写（例如用户点图后编辑区才挂上）。
 * 绝不监听 attributes/characterData：否则会跟受控输入联动，触发无限 fill → 平台一直「加载中」。
 */
function startFillObserver(title: string, body: string, durationMs: number): void {
  const { maxRefill: MAX_REFILL, windowMs } = observerCaps(body);
  const stopAfterMs = Math.min(durationMs, windowMs);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let fillBurst = 0;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    obs.disconnect();
    if (debounceTimer != null) clearTimeout(debounceTimer);
  };

  const obs = new MutationObserver(() => {
    if (stopped) return;
    if (!needsDomRefill(title, body)) {
      stop();
      return;
    }
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (stopped || !needsDomRefill(title, body)) {
        stop();
        return;
      }
      fillBurst++;
      if (fillBurst > MAX_REFILL) {
        stop();
        return;
      }
      fillDom(title, body);
    }, 1000);
  });

  obs.observe(document.documentElement, { subtree: true, childList: true });

  if (!needsDomRefill(title, body)) {
    stop();
    return;
  }
  fillDom(title, body);
  fillBurst++;

  window.setTimeout(stop, stopAfterMs);
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const u = raw.trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function listImageFileInputs(): HTMLInputElement[] {
  const out: HTMLInputElement[] = [];
  for (const root of allRootsBfs()) {
    root.querySelectorAll("input[type=file]").forEach((el) => {
      if (el instanceof HTMLInputElement) out.push(el);
    });
  }
  return out;
}

function assignFileToInput(input: HTMLInputElement, blob: Blob): boolean {
  try {
    const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/png";
    const ext = type.includes("png") ? "png" : type.includes("jpeg") || type.includes("jpg") ? "jpg" : "png";
    const file = new File([blob], `xhs-bridge-upload.${ext}`, { type });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

function assignMultipleFilesToInput(input: HTMLInputElement, blobs: Blob[]): boolean {
  if (!blobs.length) return false;
  try {
    const dt = new DataTransfer();
    blobs.forEach((blob, i) => {
      const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/png";
      const ext = type.includes("png") ? "png" : type.includes("jpeg") || type.includes("jpg") ? "jpg" : "png";
      dt.items.add(new File([blob], `xhs-bridge-${i + 1}.${ext}`, { type }));
    });
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

async function placeholderBlob(): Promise<Blob> {
  return (await fetch(`data:image/png;base64,${PLACEHOLDER_PNG_BASE64}`)).blob();
}

async function fetchOneImageBlob(url: string): Promise<Blob | null> {
  const u = url.trim();
  const allowed =
    u.startsWith("https://") || u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost");
  if (!allowed) return null;
  try {
    const resp = await new Promise<FetchImageResp>((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { channel: "XHS_PUBLISH_BRIDGE", action: "FETCH_IMAGE_BLOB", url: u },
          (r: FetchImageResp) => resolve(r || { ok: false })
        );
      } catch {
        resolve({ ok: false });
      }
    });
    if (resp.ok && resp.base64) {
      const mime = resp.mime || "image/jpeg";
      const dataUrl = `data:${mime};base64,${resp.base64}`;
      return await (await fetch(dataUrl)).blob();
    }
  } catch {
    /* */
  }
  try {
    const r = await fetch(u, { mode: "cors", credentials: "omit" });
    if (r.ok) return await r.blob();
  } catch {
    /* */
  }
  return null;
}

/** 按顺序拉取相册用 Blob，最多 9 张；无可用 URL 时用占位图 */
async function loadAlbumBlobs(urls: string[]): Promise<Blob[]> {
  if (!urls.length) return [await placeholderBlob()];
  const max = 9;
  const out: Blob[] = [];
  for (const u of urls.slice(0, max)) {
    const b = await fetchOneImageBlob(u);
    if (b) out.push(b);
  }
  return out.length ? out : [await placeholderBlob()];
}

async function triggerProgrammaticImageUpload(imageUrls: string[]): Promise<boolean> {
  const blobs = await loadAlbumBlobs(imageUrls);
  let inputs = listImageFileInputs();
  if (!inputs.length) {
    clickUploadImagePrimaryCta();
    await sleep(900);
    inputs = listImageFileInputs();
  }
  if (!inputs.length) {
    void clickLabelForFileInput();
    await sleep(600);
    inputs = listImageFileInputs();
  }
  if (!inputs.length) {
    clickUploadImagePrimaryCta();
    await sleep(1200);
    inputs = listImageFileInputs();
  }
  if (!inputs.length) return false;

  if (blobs.length > 1) {
    const preferMulti = inputs.find((i) => i.multiple);
    if (preferMulti && assignMultipleFilesToInput(preferMulti, blobs)) return true;
    for (const input of inputs) {
      const accept = (input.getAttribute("accept") || "").toLowerCase();
      if (accept && !accept.includes("image") && accept !== "") continue;
      if (assignMultipleFilesToInput(input, blobs)) return true;
    }
  }

  const single = blobs[0];
  for (const input of inputs) {
    const accept = (input.getAttribute("accept") || "").toLowerCase();
    if (accept && !accept.includes("image") && accept !== "") continue;
    if (assignFileToInput(input, single)) return true;
  }
  return false;
}

async function ensureImageTextModeThenFill(
  title: string,
  body: string,
  imageUrls: string[]
): Promise<FillResult> {
  /** 与主流程解耦：用户稍后手动点图出编辑区时仍能补写，约 48s 后自行停止 */
  startFillObserver(title, body, 48_000);

  if (!hasPublishFormFields()) {
    clickUploadImageTextTab();
    await sleep(1600);
  }

  let imageTriggered = false;
  for (let attempt = 0; attempt < 5 && !hasPublishFormFields(); attempt++) {
    if (attempt === 0 && !listImageFileInputs().length) {
      clickUploadImagePrimaryCta();
      await sleep(700);
    }
    imageTriggered = (await triggerProgrammaticImageUpload(imageUrls)) || imageTriggered;
    await sleep(3200);
    if (!hasPublishFormFields()) {
      clickUploadImageTextTab();
      await sleep(600);
    }
  }

  let r = fillDom(title, body);
  for (let i = 0; i < 8 && !r.ok; i++) {
    await sleep(900);
    if (!hasPublishFormFields()) {
      imageTriggered = (await triggerProgrammaticImageUpload(imageUrls)) || imageTriggered;
      await sleep(2800);
    }
    r = fillDom(title, body);
  }

  if (r.ok) {
    fillDom(title, body);
  }

  return {
    ...r,
    filled: { ...r.filled, image_upload: imageTriggered },
    detail: r.ok
      ? r.detail
      : r.detail ||
        (imageTriggered
          ? "image_injected_but_title_body_not_found"
          : "could_not_open_editor_try_manual_upload_image")
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.channel !== "XHS_PUBLISH_BRIDGE") {
    sendResponse({ ok: false, detail: "bad_inner_message" });
    return false;
  }

  if (msg.action === "FILL_DOM") {
    const payload = msg.payload as {
      title: string;
      body: string;
      firstImageUrl?: string;
      imageUrls?: string[];
    };
    const merged: string[] = [];
    if (payload.imageUrls?.length) merged.push(...payload.imageUrls);
    if (payload.firstImageUrl?.trim()) merged.push(payload.firstImageUrl.trim());
    const imageList = dedupeUrls(merged).slice(0, 9);
    void ensureImageTextModeThenFill(payload.title || "", payload.body || "", imageList).then((r) =>
      sendResponse(r)
    );
    return true;
  }

  if (msg.action === "SCRAPE_SEARCH_DOM") {
    const limitRaw = Number((msg.payload as { limit?: number } | undefined)?.limit ?? 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, Math.floor(limitRaw))) : 10;
    void (async () => {
      try {
        // 等一等首屏卡片渲染
        await new Promise((r) => setTimeout(r, 900));
        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>(
            'a[href^="/explore/"],a[href*="/explore/"],a[href^="/discovery/item/"],a[href*="/discovery/item/"]'
          )
        );
        const items: { url: string; title: string; author?: string; excerpt?: string; like_text?: string }[] =
          [];
        const seen = new Set<string>();
        for (const a of anchors) {
          const href = (a.getAttribute("href") || "").trim();
          if (!href) continue;
          const abs = href.startsWith("http") ? href : `https://www.xiaohongshu.com${href}`;
          if (seen.has(abs)) continue;

          // 尝试从卡片容器提取标题/作者/摘要/点赞
          const card = a.closest<HTMLElement>("section, article, div");
          const text = (card?.innerText || a.innerText || "").replace(/\s+/g, " ").trim();
          let title = "";
          let excerpt = "";
          if (text) {
            const parts = text.split(" ").filter(Boolean);
            title = parts.slice(0, 16).join(" ").slice(0, 80);
            excerpt = parts.slice(16, 44).join(" ").slice(0, 120);
          }

          // 兜底：部分卡片 title 在 aria-label
          if (!title) {
            const aria = (a.getAttribute("aria-label") || "").trim();
            if (aria) title = aria.replace(/\s+/g, " ").slice(0, 80);
          }

          if (!title) continue;
          seen.add(abs);

          // 点赞等信息很不稳定：尽量从卡片文本里找一个数字片段
          const likeText =
            (text.match(/(\d+(\.\d+)?)(万|w|W)?/u)?.[0] || "").slice(0, 12) || undefined;

          items.push({
            url: abs,
            title,
            excerpt: excerpt || undefined,
            like_text: likeText
          });
          if (items.length >= limit) break;
        }
        sendResponse({ ok: true, items });
      } catch (e) {
        sendResponse({ ok: false, error: "scrape_dom_error", detail: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "SCRAPE_PAGE_NOTES") {
    const limitRaw = Number((msg.payload as { limit?: number } | undefined)?.limit ?? 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, Math.floor(limitRaw))) : 10;
    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, 900));
        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>(
            'a[href^="/explore/"],a[href*="/explore/"],a[href^="/discovery/item/"],a[href*="/discovery/item/"]'
          )
        );
        const items: { url: string; title: string; author?: string; excerpt?: string; like_text?: string }[] =
          [];
        const seen = new Set<string>();
        for (const a of anchors) {
          const href = (a.getAttribute("href") || "").trim();
          if (!href) continue;
          const abs = href.startsWith("http") ? href : `https://www.xiaohongshu.com${href}`;
          if (seen.has(abs)) continue;
          const card = a.closest<HTMLElement>("section, article, div");
          const text = (card?.innerText || a.innerText || "").replace(/\s+/g, " ").trim();
          let title = "";
          let excerpt = "";
          if (text) {
            const parts = text.split(" ").filter(Boolean);
            title = parts.slice(0, 16).join(" ").slice(0, 80);
            excerpt = parts.slice(16, 44).join(" ").slice(0, 120);
          }
          if (!title) {
            const aria = (a.getAttribute("aria-label") || "").trim();
            if (aria) title = aria.replace(/\s+/g, " ").slice(0, 80);
          }
          if (!title) continue;
          seen.add(abs);
          const likeText =
            (text.match(/(\d+(\.\d+)?)(万|w|W)?/u)?.[0] || "").slice(0, 12) || undefined;
          items.push({ url: abs, title, excerpt: excerpt || undefined, like_text: likeText });
          if (items.length >= limit) break;
        }
        sendResponse({ ok: true, items });
      } catch (e) {
        sendResponse({ ok: false, error: "scrape_dom_error", detail: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "SCRAPE_EXPLORE_RELATED_DOM") {
    const limitRaw = Number((msg.payload as { limit?: number } | undefined)?.limit ?? 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, Math.floor(limitRaw))) : 10;
    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, 1100));
        const cur = window.location.href.split("#")[0];
        const root = document.querySelector("main") || document.body;
        const anchors = Array.from(
          root.querySelectorAll<HTMLAnchorElement>('a[href^="/explore/"],a[href*="/explore/"]')
        );
        const items: { url: string; title: string; excerpt?: string; like_text?: string }[] = [];
        const seen = new Set<string>();
        for (const a of anchors) {
          const href = (a.getAttribute("href") || "").trim();
          if (!href) continue;
          const abs = href.startsWith("http") ? href : `https://www.xiaohongshu.com${href}`;
          const clean = abs.split("?")[0];
          if (clean === cur.split("?")[0]) continue;
          if (seen.has(clean)) continue;

          const card = a.closest<HTMLElement>("section, article, div");
          const text = (card?.innerText || a.innerText || "").replace(/\s+/g, " ").trim();
          let title = "";
          let excerpt = "";
          if (text) {
            const parts = text.split(" ").filter(Boolean);
            title = parts.slice(0, 18).join(" ").slice(0, 80);
            excerpt = parts.slice(18, 50).join(" ").slice(0, 140);
          }
          if (!title) {
            const aria = (a.getAttribute("aria-label") || "").trim();
            if (aria) title = aria.replace(/\s+/g, " ").slice(0, 80);
          }
          if (!title) continue;
          seen.add(clean);
          const likeText =
            (text.match(/(\d+(\.\d+)?)(万|w|W)?/u)?.[0] || "").slice(0, 12) || undefined;
          items.push({ url: abs, title, excerpt: excerpt || undefined, like_text: likeText });
          if (items.length >= limit) break;
        }
        sendResponse({ ok: true, items });
      } catch (e) {
        sendResponse({ ok: false, error: "scrape_dom_error", detail: String(e) });
      }
    })();
    return true;
  }

  sendResponse({ ok: false, detail: "unsupported_inner_action" });
  return false;
});
