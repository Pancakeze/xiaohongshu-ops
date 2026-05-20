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

/** 从 aria-label 抽点赞（站内常见：`7478次点赞`、`1.2万次点赞`）。 */
function extractLikesFromAriaLabels(root: HTMLElement | null): string | undefined {
  if (!root) return undefined;
  const seen = new Set<string>();
  const visit = (el: HTMLElement) => {
    const al = (el.getAttribute("aria-label") || "").trim();
    if (!al || seen.has(al)) return;
    seen.add(al);
    let m = al.match(/^([\d,]+(?:\.\d+)?万?)\s*次点赞/u);
    if (m) return m[1].replace(/,/g, "").slice(0, 12);
    m = al.match(/([\d,]+(?:\.\d+)?万?)\s*次点赞/u);
    if (m) return m[1].replace(/,/g, "").slice(0, 12);
    m = al.match(/^([\d,]+(?:\.\d+)?万?)\s*次喜欢/u);
    if (m) return m[1].replace(/,/g, "").slice(0, 12);
    m = al.match(/\b([\d,]+(?:\.\d+)?)\s*likes?\b/i);
    if (m) return m[1].replace(/,/g, "").slice(0, 12);
    return undefined;
  };
  const hit = visit(root);
  if (hit) return hit;
  for (const el of root.querySelectorAll<HTMLElement>("[aria-label]")) {
    const v = visit(el);
    if (v) return v;
  }
  return undefined;
}

/**
 * 搜索/Feed 卡片：尽量抽取「点赞」展示文案。旧逻辑用「全文第一个数字」易误匹配标题里的年份、视频时长等。
 * 真实页面上点赞多在底部栏，且常有 `aria-label="…次点赞"`，优先走 DOM。
 */
function extractLikesDisplayFromCard(card: HTMLElement | null, blob: string): string | undefined {
  const fromAria = extractLikesFromAriaLabels(card);
  if (fromAria) return fromAria;

  const text = blob.replace(/\s+/g, " ").trim();
  if (!text) return undefined;

  const en = text.match(/\b(\d+(?:,\d{3})*)\s*likes?\b/i);
  if (en) return en[1].replace(/,/g, "").slice(0, 12);

  const z1 = text.match(/([\d.]+(?:万|w|W)?)\s*赞/);
  if (z1) return z1[1].slice(0, 12);
  const z2 = text.match(/赞\s*([\d.]+(?:万|w|W)?)/);
  if (z2) return z2[1].slice(0, 12);

  const afterDate = text.match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+([\d.]+(?:万|w|W)?)/);
  if (afterDate) return afterDate[1].slice(0, 12);

  const afterRel = text.match(
    /(?:\d+天前|\d+小时前|\d+分钟前|昨天|前天|刚刚)\s+([\d.]+(?:万|w|W)?)/u
  );
  if (afterRel) return afterRel[1].slice(0, 12);

  const wanAll = [...text.matchAll(/(\d+(?:\.\d+)?万)/g)];
  if (wanAll.length) return wanAll[wanAll.length - 1][1].slice(0, 12);

  if (card) {
    const likeSpan = Array.from(card.querySelectorAll<HTMLElement>("span, div")).find((el) => {
      const raw = (el.textContent || "").trim();
      if (!/^\d/.test(raw) || raw.length > 14) return false;
      const p = el.parentElement?.textContent || "";
      return /赞/.test(p) && /\d/.test(raw);
    });
    if (likeSpan) {
      const m = (likeSpan.textContent || "").trim().match(/^([\d.]+(?:万|w|W)?)/);
      if (m) return m[1].slice(0, 12);
    }
    const footNum = extractLikesFromFooterLastPlainNumber(card);
    if (footNum) return footNum;
  }

  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从标题/摘要行尾部去掉日期、点赞展示等（与 extractLikesDisplayFromCard 配套）。 */
function stripFooterFromLine(line: string, likeText: string | undefined): string {
  let s = line.trim();
  for (let i = 0; i < 12; i++) {
    const before = s;
    if (likeText) {
      const lt = likeText.trim();
      if (lt) s = s.replace(new RegExp(`\\s*${escapeRegExp(lt)}\\s*$`, "u"), "").trimEnd();
    }
    s = s.replace(/\s+\d{4}-\d{1,2}-\d{1,2}\s*$/u, "").trimEnd();
    s = s.replace(/\s+\d{1,2}-\d{1,2}-\d{1,2}\s*$/u, "").trimEnd();
    s = s.replace(/\s+\d{1,2}-\d{1,2}\s*$/u, "").trimEnd();
    s = s.replace(/\s+\d+天前\s*$/u, "").trimEnd();
    s = s.replace(/\s+\d+小时前\s*$/u, "").trimEnd();
    s = s.replace(/\s+\d+分钟前\s*$/u, "").trimEnd();
    s = s.replace(/\s+\d+周前\s*$/u, "").trimEnd();
    s = s.replace(/\s+\d+月前\s*$/u, "").trimEnd();
    s = s.replace(/\s+(昨天|前天|刚刚)\s*$/u, "").trimEnd();
    s = s.replace(/\s+赞\s*[\d.]+(?:万|w|W)?\s*$/u, "").trimEnd();
    if (s === before) break;
  }
  return s.trim();
}

/**
 * 卡片 innerText 常为「标题\\n作者 日期 点赞」或挤成一行；尽量不把底部元数据并进 title。
 */
function extractTitleExcerptFromCardBlob(rawBlob: string, likeText: string | undefined): { title: string; excerpt: string } {
  const raw = rawBlob.replace(/\r/g, "\n").trim();
  const lines = raw.split("\n").map((l) => l.replace(/[\t ]+/g, " ").trim()).filter(Boolean);
  if (lines.length >= 2) {
    const title = stripFooterFromLine(lines[0], likeText).slice(0, 120);
    const excerpt = stripFooterFromLine(lines.slice(1).join(" "), likeText).slice(0, 200);
    return { title: title || lines[0].slice(0, 100), excerpt };
  }
  const flat = raw.replace(/\s+/g, " ").trim();
  const cleaned = stripFooterFromLine(flat, likeText);
  const splitMeta = cleaned.match(
    /^(.+?)(\s+(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})(?:\s|$).*)$/u
  );
  if (splitMeta && splitMeta[1].trim().length >= 4) {
    return {
      title: splitMeta[1].trim().slice(0, 120),
      excerpt: stripFooterFromLine(splitMeta[2].trim(), likeText).slice(0, 200),
    };
  }
  const splitRel = cleaned.match(
    /^(.+?)(\s+(?:\d+天前|\d+小时前|\d+分钟前|\d+周前|\d+月前|昨天|前天|刚刚)(?:\s|$).*)$/u
  );
  if (splitRel && splitRel[1].trim().length >= 4) {
    return {
      title: splitRel[1].trim().slice(0, 120),
      excerpt: stripFooterFromLine(splitRel[2].trim(), likeText).slice(0, 200),
    };
  }
  return { title: cleaned.slice(0, 120), excerpt: "" };
}

/** 底部栏最右侧常为纯数字点赞；叶子节点避免拿到整块 footer 文本。 */
function extractLikesFromFooterLastPlainNumber(card: HTMLElement): string | undefined {
  const foot =
    card.querySelector<HTMLElement>('[class*="footer"], [class*="Footer"]') ||
    card.querySelector<HTMLElement>('[class*="interact"]');
  if (!foot) return undefined;
  const leaves = Array.from(foot.querySelectorAll<HTMLElement>("span, i, b, em, strong")).filter(
    (el) => el.children.length === 0
  );
  const nums = leaves.filter((el) => {
    const t = (el.textContent || "").replace(/\s+/g, "").trim();
    return /^\d[\d,]{0,11}$/.test(t);
  });
  if (!nums.length) return undefined;
  const t = (nums[nums.length - 1].textContent || "").replace(/\s+/g, "").replace(/,/g, "").trim();
  return t.slice(0, 12);
}

/**
 * 真实版式：封面下标题块与底部作者/点赞栏分离。优先取 footer 上方的兄弟节点首行。
 */
function extractSearchCardTitleFromDom(scope: HTMLElement | null): string | undefined {
  if (!scope) return undefined;
  const foot = scope.querySelector<HTMLElement>('[class*="footer"], [class*="Footer"]');
  if (foot?.parentElement) {
    const parent = foot.parentElement;
    const idx = Array.prototype.indexOf.call(parent.children, foot);
    for (let j = idx - 1; j >= 0; j--) {
      const el = parent.children[j];
      if (!(el instanceof HTMLElement)) continue;
      const cls = String(el.className || "");
      if (/footer|Footer/i.test(cls)) continue;
      const raw = (el.innerText || "").trim();
      const first = raw.split(/\n/).map((x) => x.trim()).find(Boolean);
      if (first && first.length >= 2 && first.length <= 120 && !/^\d+$/.test(first)) return first;
    }
  }
  const kids = Array.from(scope.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
  for (let i = kids.length - 2; i >= 0; i--) {
    const el = kids[i];
    const cls = String(el.className || "");
    if (/footer|Footer/i.test(cls)) continue;
    const first =
      (el.innerText || "")
        .split(/\n/)
        .map((x) => x.trim())
        .find(Boolean) || "";
    if (first.length >= 4 && first.length <= 120 && !/^\d+$/.test(first)) return first;
  }
  return undefined;
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

  /** 创作页相册多为 multiple；单图也走 DataTransfer 多文件 API，避免仅 assignFile 无效 */
  const preferMulti = inputs.find((i) => i.multiple);
  if (preferMulti && assignMultipleFilesToInput(preferMulti, blobs)) return true;
  for (const input of inputs) {
    const accept = (input.getAttribute("accept") || "").toLowerCase();
    if (accept && !accept.includes("image") && accept !== "") continue;
    if (assignMultipleFilesToInput(input, blobs)) return true;
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
  imageUrls: string[],
  options?: { skipImageUpload?: boolean }
): Promise<FillResult> {
  /** 与主流程解耦：用户稍后手动点图出编辑区时仍能补写，约 48s 后自行停止 */
  startFillObserver(title, body, 48_000);

  let imageTriggered = false;

  if (!options?.skipImageUpload) {
    if (!hasPublishFormFields()) {
      clickUploadImageTextTab();
      await sleep(1600);
    }
    if (!listImageFileInputs().length) {
      clickUploadImagePrimaryCta();
      await sleep(900);
    }
    /** 小红书相册多为追加：同批 URL 只上传一次，避免重试循环叠图 */
    imageTriggered = await triggerProgrammaticImageUpload(imageUrls);
    for (let wait = 0; wait < 12 && !hasPublishFormFields(); wait++) {
      await sleep(1500);
      if (!imageTriggered && wait > 0 && wait % 2 === 1) {
        imageTriggered = await triggerProgrammaticImageUpload(imageUrls);
      }
      if (wait % 3 === 2) {
        clickUploadImageTextTab();
        await sleep(500);
      }
    }
  }

  let r = fillDom(title, body);
  for (let i = 0; i < 8 && !r.ok; i++) {
    await sleep(900);
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
      skipImageUpload?: boolean;
    };
    const merged: string[] = payload.imageUrls?.length
      ? [...payload.imageUrls]
      : payload.firstImageUrl?.trim()
        ? [payload.firstImageUrl.trim()]
        : [];
    const imageList = dedupeUrls(merged).slice(0, 9);
    void ensureImageTextModeThenFill(payload.title || "", payload.body || "", imageList, {
      skipImageUpload: Boolean(payload.skipImageUpload)
    }).then((r) => sendResponse(r));
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

          // 尝试从卡片容器提取标题/摘要/点赞（避免把底部作者/日期/点赞并进 title）
          const card = a.closest<HTMLElement>("section, article, div");
          const rawBlob = (card?.innerText || a.innerText || "").trim();
          const text = rawBlob.replace(/\s+/g, " ").trim();
          const likeText = extractLikesDisplayFromCard(card, text);
          let { title, excerpt } = extractTitleExcerptFromCardBlob(rawBlob, likeText);
          const domTitle = extractSearchCardTitleFromDom(card ?? a);
          if (domTitle) {
            const tDom = stripFooterFromLine(domTitle, likeText).slice(0, 120);
            if (tDom) title = tDom;
          }
          if (!title) {
            const aria = (a.getAttribute("aria-label") || "").trim();
            if (aria) {
              const tec = extractTitleExcerptFromCardBlob(aria, likeText);
              title = tec.title;
              if (!excerpt) excerpt = tec.excerpt;
            }
          }

          if (!title) continue;
          seen.add(abs);

          items.push({
            url: abs,
            title,
            excerpt: excerpt.trim() || undefined,
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
          const rawBlob = (card?.innerText || a.innerText || "").trim();
          const text = rawBlob.replace(/\s+/g, " ").trim();
          const likeText = extractLikesDisplayFromCard(card, text);
          let { title, excerpt } = extractTitleExcerptFromCardBlob(rawBlob, likeText);
          const domTitle = extractSearchCardTitleFromDom(card ?? a);
          if (domTitle) {
            const tDom = stripFooterFromLine(domTitle, likeText).slice(0, 120);
            if (tDom) title = tDom;
          }
          if (!title) {
            const aria = (a.getAttribute("aria-label") || "").trim();
            if (aria) {
              const tec = extractTitleExcerptFromCardBlob(aria, likeText);
              title = tec.title;
              if (!excerpt) excerpt = tec.excerpt;
            }
          }
          if (!title) continue;
          seen.add(abs);
          items.push({
            url: abs,
            title,
            excerpt: excerpt.trim() || undefined,
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
          const rawBlob = (card?.innerText || a.innerText || "").trim();
          const text = rawBlob.replace(/\s+/g, " ").trim();
          const likeText = extractLikesDisplayFromCard(card, text);
          let { title, excerpt } = extractTitleExcerptFromCardBlob(rawBlob, likeText);
          const domTitle = extractSearchCardTitleFromDom(card ?? a);
          if (domTitle) {
            const tDom = stripFooterFromLine(domTitle, likeText).slice(0, 120);
            if (tDom) title = tDom;
          }
          if (!title) {
            const aria = (a.getAttribute("aria-label") || "").trim();
            if (aria) {
              const tec = extractTitleExcerptFromCardBlob(aria, likeText);
              title = tec.title;
              if (!excerpt) excerpt = tec.excerpt;
            }
          }
          if (!title) continue;
          seen.add(clean);
          items.push({
            url: abs,
            title,
            excerpt: excerpt.trim() || undefined,
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

  if (msg.action === "SCRAPE_CREATOR_ANALYTICS_DOM") {
    const limitRaw = Number((msg.payload as { limit?: number } | undefined)?.limit ?? 80);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 80;
    void (async () => {
      try {
        const items = await scrapeCreatorPublishedNotes(limit);
        sendResponse({ ok: true, items });
      } catch (e) {
        sendResponse({ ok: false, error: "scrape_dom_error", detail: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "PING_CONTENT") {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "DEBUG_NOTE_MANAGER_DOM") {
    sendResponse({
      ok: true,
      url: location.href,
      rows: findNoteManagerRows().length,
      notes: document.querySelectorAll(".note, motion-div.note").length,
      impressions: document.querySelectorAll("[data-impression]").length
    });
    return false;
  }

  if (msg.action === "PREPARE_NOTE_MANAGER_FOR_CLICKS") {
    void (async () => {
      try {
        await clickNoteManagerTab("all");
        await scrollNoteManagerList(3);
        await sleep(400);
        sendResponse({ ok: true, rows: findNoteManagerRows().length });
      } catch (e) {
        sendResponse({ ok: false, detail: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "PREPARE_POSTED_API") {
    const prepPayload = (msg.payload as { loadAllPages?: boolean } | undefined) || {};
    void (async () => {
      try {
        const cached = await warmPostedApiCacheOnPage(prepPayload.loadAllPages === true);
        sendResponse({ ok: true, cached });
      } catch (e) {
        sendResponse({ ok: false, detail: String(e), cached: 0 });
      }
    })();
    return true;
  }

  if (msg.action === "POSTED_API_STATS") {
    const statPayload = (msg.payload as { mainPayloads?: unknown[] } | undefined) || {};
    const stats = postedPayloadsNoteStats(statPayload.mainPayloads);
    sendResponse({
      ok: true,
      ...stats,
      needsMore: stats.total != null && stats.collected < stats.total
    });
    return false;
  }

  if (msg.action === "SCROLL_POSTED_LIST") {
    void (async () => {
      try {
        await loadMorePostedPagesViaScroll();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, detail: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "CLICK_NOTE_COVER_AND_CAPTURE") {
    const payload = (msg.payload as { title?: string; note_id?: string } | undefined) || {};
    const title = String(payload.title || "").trim();
    const noteId = String(payload.note_id || "").trim().toLowerCase();
    void (async () => {
      try {
        const row =
          (noteId ? findNoteRowByNoteId(noteId) : undefined) ||
          (title ? findNoteRowByTitle(title) : undefined);
        if (!row) {
          sendResponse({ ok: false, detail: "row_not_found" });
          return;
        }
        const clickEl = findNoteCoverClickTarget(row);
        if (!clickEl) {
          sendResponse({ ok: false, detail: "cover_not_found" });
          return;
        }
        const official_url = await resolveExploreUrlByClick(clickEl);
        if (official_url && isTrustedExploreUrl(official_url)) {
          sendResponse({ ok: true, official_url });
          return;
        }
        sendResponse({ ok: false, detail: "capture_failed" });
      } catch (e) {
        sendResponse({ ok: false, detail: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "RESOLVE_CREATOR_NOTE_LINK") {
    const title = String((msg.payload as { title?: string } | undefined)?.title || "").trim();
    void (async () => {
      try {
        const row = title ? findNoteRowByTitle(title) : undefined;
        if (!row) {
          sendResponse({ ok: true, official_url: undefined });
          return;
        }
        const clickEl = findNoteCoverClickTarget(row);
        if (!clickEl) {
          sendResponse({ ok: true, official_url: undefined });
          return;
        }
        clickEl.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(150);
        const official_url = await resolveExploreUrlByClick(clickEl);
        sendResponse({ ok: true, official_url });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "FETCH_CREATOR_POSTED_NOTES") {
    const payload =
      (msg.payload as { limit?: number; tab?: number; mainPayloads?: unknown[] } | undefined) || {};
    const limitRaw = Number(payload.limit ?? 80);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 80;
    const tab = Number.isFinite(Number(payload.tab)) ? Math.floor(Number(payload.tab)) : 0;
    const mainPayloads = Array.isArray(payload.mainPayloads) ? payload.mainPayloads : [];
    void (async () => {
      try {
        await warmPostedApiCacheOnPage();
        const result = await fetchCreatorPostedNotesFromApi(limit, tab, mainPayloads);
        if (!result.ok) {
          sendResponse(result);
          return;
        }
        const items = result.items;
        const withLink = items.filter((x) => x.official_url?.includes("xsec_token")).length;
        sendResponse({
          ok: true,
          items,
          pages: result.pages,
          meta: {
            linksFound: withLink,
            total: items.length,
            source: result.source || "posted_api",
            apiError: result.apiError
          }
        });
      } catch (e) {
        sendResponse({ ok: false, error: "posted_api_error", detail: String(e), items: [] });
      }
    })();
    return true;
  }

  if (msg.action === "SCRAPE_CREATOR_NOTE_MANAGER_DOM") {
    const payload =
      (msg.payload as {
        limit?: number;
        resolveLinksByClick?: boolean;
        catalogOnly?: boolean;
        matchTitles?: string[];
      } | undefined) || {};
    const limitRaw = Number(payload.limit ?? 80);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 80;
    const resolveLinksByClick = payload.resolveLinksByClick === true;
    const catalogOnly = payload.catalogOnly === true;
    const matchTitles = Array.isArray(payload.matchTitles)
      ? payload.matchTitles.map((t) => String(t).trim()).filter((t) => t.length >= 2)
      : undefined;
    void (async () => {
      try {
        const items =
          catalogOnly && matchTitles?.length
            ? await scrapeCreatorNoteCatalogOnly(limit, matchTitles)
            : await scrapeCreatorNoteManagerLinks(limit, resolveLinksByClick, matchTitles);
        const withLink = items.filter((x) => x.official_url?.includes("/explore/")).length;
        const domRows = findNoteManagerRows().length;
        const impressionList = harvestNoteCatalog();
        sendResponse({
          ok: true,
          items,
          meta: {
            rowsFound: items.length,
            linksFound: withLink,
            domRows,
            impressionNodes: document.querySelectorAll("[data-impression]").length,
            impressionWithTitle: impressionList.filter((x) => x.title.length >= 2).length,
            matchTitlesRequested: matchTitles?.length ?? 0
          }
        });
      } catch (e) {
        sendResponse({ ok: false, error: "scrape_dom_error", detail: String(e) });
      }
    })();
    return true;
  }

  sendResponse({ ok: false, detail: "unsupported_inner_action" });
  return false;
});

function parseMetricInt(raw: string): number | undefined {
  const s = raw.replace(/,/g, "").trim();
  if (!s || s === "—" || s === "-") return undefined;
  const m = s.match(/^\+?(\d+)$/);
  if (m) return parseInt(m[1], 10);
  return undefined;
}

function parseMetricPct(raw: string): number | undefined {
  const s = raw.trim();
  const m = s.match(/^([\d.]+)\s*%$/);
  if (m) return parseFloat(m[1]);
  return undefined;
}

function parseWatchSeconds(raw: string): number | undefined {
  const s = raw.trim().toLowerCase();
  const m = s.match(/^(\d+)\s*s(?:ec)?$/);
  if (m) return parseInt(m[1], 10);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return undefined;
}

function parsePublishedAtFromText(text: string): string | undefined {
  const m = text.match(/发布于\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
  return m ? m[1] : undefined;
}

function parsePublishedAtLoose(text: string): string | undefined {
  const fromLabel = parsePublishedAtFromText(text);
  if (fromLabel) return fromLabel;
  const cn = text.match(/发布于\s*(\d{4})年(\d{2})月(\d{2})日(?:\s+(\d{2}):(\d{2}))?/);
  if (cn) {
    const time = cn[4] != null && cn[5] != null ? ` ${cn[4]}:${cn[5]}` : "";
    return `${cn[1]}-${cn[2]}-${cn[3]}${time}`;
  }
  const m = text.match(/(\d{4})[-/](\d{2})[-/](\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return undefined;
  const time = m[4] != null && m[5] != null ? ` ${m[4]}:${m[5]}` : "";
  return `${m[1]}-${m[2]}-${m[3]}${time}`;
}

function normalizeExploreUrl(href: string): string | undefined {
  const raw = href.trim();
  if (!raw || raw === "#" || raw.startsWith("javascript:")) return undefined;
  let url = raw;
  if (url.startsWith("//")) url = `https:${url}`;
  else if (url.startsWith("/")) url = `https://www.xiaohongshu.com${url}`;
  if (url.includes("creator.xiaohongshu.com")) return undefined;
  if (!url.includes("xiaohongshu.com") || !url.includes("/explore/")) return undefined;
  try {
    const u = new URL(url);
    if (!/\/explore\/[a-f0-9]+/i.test(u.pathname)) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

function decodeJsonStringLiteral(raw: string): string {
  try {
    return JSON.parse(`"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`) as string;
  } catch {
    return raw.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\//g, "/");
  }
}

function extractExploreFromElement(el: HTMLElement): string | undefined {
  for (const a of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const u = normalizeExploreUrl(a.getAttribute("href") || a.href || "");
    if (u && isTrustedExploreUrl(u)) return u;
  }
  const html = el.innerHTML;
  const abs = html.match(/https?:\/\/www\.xiaohongshu\.com\/explore\/[a-f0-9]{16,}[^"'\\s]*/i);
  if (abs) return normalizeExploreUrl(abs[0]);
  const rel = html.match(/\/explore\/([a-f0-9]{16,})/i);
  if (rel) return normalizeExploreUrl(`https://www.xiaohongshu.com/explore/${rel[1]}`);
  return undefined;
}

function harvestNoteIdFromJson(value: unknown, depth = 0): string | undefined {
  if (depth > 10 || value == null) return undefined;
  if (typeof value === "string" && /^[a-f0-9]{16,}$/i.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) {
    for (const it of value) {
      const found = harvestNoteIdFromJson(it, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  for (const k of ["noteId", "note_id", "id"]) {
    const v = o[k];
    if (typeof v === "string" && /^[a-f0-9]{16,}$/i.test(v)) return v.toLowerCase();
  }
  for (const v of Object.values(o)) {
    const found = harvestNoteIdFromJson(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** 笔记卡片：noteId 在 noteTarget.value.noteId；页面级 notes-container 的 impression 无 noteId */
function parseNoteIdFromImpressionAttr(impressionRaw: string): string | undefined {
  let impression = impressionRaw.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, "&");
  if (!impression) return undefined;

  const byRegex = impression.match(/"noteId"\s*:\s*"([a-f0-9]{16,})"/i);
  if (byRegex) return byRegex[1].toLowerCase();

  try {
    const data = JSON.parse(impression) as Record<string, unknown>;
    const fromWalk = harvestNoteIdFromJson(data);
    if (fromWalk) return fromWalk;

    const noteTarget = data.noteTarget as Record<string, unknown> | undefined;
    const val = noteTarget?.value as Record<string, unknown> | undefined;
    const nested = val?.noteId ?? val?.note_id;
    if (typeof nested === "string" && /^[a-f0-9]{16,}$/i.test(nested)) return nested.toLowerCase();
  } catch {
    /* ignore */
  }
  return undefined;
}

function isNoteCardImpressionElement(el: HTMLElement): boolean {
  if (el.classList.contains("note")) return true;
  return Boolean(el.closest(".note"));
}

type ImpressionNoteMeta = { noteId: string; title: string };

function parseImpressionNoteMeta(impressionRaw: string): ImpressionNoteMeta | undefined {
  let impression = impressionRaw.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, "&");
  if (!impression) return undefined;
  const noteId = parseNoteIdFromImpressionAttr(impression);
  if (!noteId) return undefined;
  let title = "";
  try {
    const data = JSON.parse(impression) as Record<string, unknown>;
    for (const k of ["title", "displayTitle", "noteTitle", "name"]) {
      if (typeof data[k] === "string" && (data[k] as string).trim().length >= 2) {
        title = (data[k] as string).trim();
        break;
      }
    }
  } catch {
    const m = impression.match(/"(?:title|displayTitle|noteTitle)"\s*:\s*"((?:[^"\\]|\\.)+)"/i);
    if (m) title = decodeJsonStringLiteral(m[1]);
  }
  return { noteId, title };
}

/** 创作中心笔记卡片标题在 .note .info .raw .title（见 DevTools），不在 data-impression JSON */
function extractTitleFromNoteCard(noteRoot: HTMLElement): string {
  const selectors = [
    ".info .raw .title",
    ".info .title",
    ".raw .title",
    "motion.div.title",
    "div.note div.title",
    ".note .title",
    "motion.div.note .title",
    "motion-div.title",
    "motion-div.note .title",
    "motion-div.info motion-div.raw motion-div.title",
    "div.title",
    ".note-title"
  ];
  for (const sel of selectors) {
    const el = noteRoot.querySelector<HTMLElement>(sel);
    if (!el) continue;
    const t = (el.textContent || "").trim().replace(/^未通过\s*/, "");
    if (t.length >= 2 && !/^(编辑|删除|权限设置|置顶|取消置顶|查看修改建议)$/.test(t)) {
      return t;
    }
  }
  return extractTitleFromNoteBlock(noteRoot.innerText || "", "");
}

function harvestImpressionNoteList(): ImpressionNoteMeta[] {
  return harvestNoteCatalog();
}

/** noteId + 标题：优先 DOM .title，再 data-impression */
function harvestNoteCatalog(): ImpressionNoteMeta[] {
  const byId = new Map<string, ImpressionNoteMeta>();

  for (const row of findNoteManagerRows()) {
    const noteRoot = getNoteCardRoot(row);
    const noteId = parseNoteIdFromRow(noteRoot);
    if (!noteId) continue;
    const title = extractTitleFromNoteCard(noteRoot);
    if (title.length < 2) continue;
    byId.set(noteId, { noteId, title });
  }

  for (const note of document.querySelectorAll<HTMLElement>(".note, motion-div.note, motion-div[class*='note']")) {
    const noteId = parseNoteIdFromRow(note);
    if (!noteId || byId.has(noteId)) continue;
    const title = extractTitleFromNoteCard(note);
    if (title.length >= 2) byId.set(noteId, { noteId, title });
  }

  for (const el of document.querySelectorAll<HTMLElement>("[data-impression]")) {
    if (!isNoteCardImpressionElement(el)) continue;
    const meta = parseImpressionNoteMeta(el.getAttribute("data-impression") || "");
    if (!meta) continue;
    const card = getNoteCardRoot(el);
    if (!card.classList.contains("note")) continue;
    const domTitle = extractTitleFromNoteCard(card);
    const title = domTitle.length >= 2 ? domTitle : meta.title;
    const prev = byId.get(meta.noteId);
    if (!prev || title.length > prev.title.length) {
      byId.set(meta.noteId, { noteId: meta.noteId, title });
    }
  }

  return Array.from(byId.values());
}

/** 笔记管理卡片：data-impression 常在子节点上（页面上没有 a 标签链接） */
function parseNoteIdFromRow(row: HTMLElement): string | undefined {
  const root =
    row.classList.contains("note") ? row : row.closest<HTMLElement>(".note") || row;

  const attrEls = [root, ...Array.from(root.querySelectorAll<HTMLElement>("[data-impression]"))];
  for (const el of attrEls) {
    const fromAttr = parseNoteIdFromImpressionAttr(el.getAttribute("data-impression") || "");
    if (fromAttr) return fromAttr;
  }

  const blob = root.outerHTML;
  const m = blob.match(/"noteId"\s*:\s*"([a-f0-9]{16,})"/i);
  return m ? m[1].toLowerCase() : undefined;
}

function getNoteCardRoot(row: HTMLElement): HTMLElement {
  if (row.classList.contains("note")) return row;
  return row.closest<HTMLElement>(".note") || row;
}

/** 从页面内嵌 JSON 提取 标题 → explore 链接（含 xsec_token） */
function harvestNoteManagerUrlByTitle(): Map<string, string> {
  const map = new Map<string, string>();
  const html = document.documentElement.innerHTML;

  for (const m of html.matchAll(
    /https?:\\?\/\\?\/www\.xiaohongshu\.com\/explore\/[a-f0-9]{16,}[^"'\\\s]*/gi
  )) {
    const url = normalizeExploreUrl(m[0].replace(/\\\//g, "/"));
    if (!url) continue;
    const idx = m.index ?? 0;
    const window = html.slice(Math.max(0, idx - 700), idx + 400);
    const titleM = window.match(/"(?:title|displayTitle|noteTitle)"\s*:\s*"((?:[^"\\]|\\.)+)"/i);
    if (titleM) {
      const title = decodeJsonStringLiteral(titleM[1]);
      const key = normPublishedTitleKey(title);
      const prev = map.get(key);
      if (!prev || url.length > prev.length) map.set(key, url);
    }
  }

  for (const m of html.matchAll(/"(?:noteId|note_id)"\s*:\s*"([a-f0-9]{16,})"/gi)) {
    const id = m[1];
    const idx = m.index ?? 0;
    const window = html.slice(idx, idx + 1400);
    const titleM = window.match(/"(?:title|displayTitle|noteTitle)"\s*:\s*"((?:[^"\\]|\\.)+)"/i);
    const urlM = window.match(/https?:\\?\/\\?\/www\.xiaohongshu\.com\/explore\/[a-f0-9]{16,}[^"'\\\s]*/i);
    const url = urlM ? normalizeExploreUrl(urlM[0].replace(/\\\//g, "/")) : undefined;
    if (!url?.includes("xsec_token")) continue;
    if (!url || !titleM) continue;
    const title = decodeJsonStringLiteral(titleM[1]);
    const key = normPublishedTitleKey(title);
    const prev = map.get(key);
    if (!prev || url.length > prev.length) map.set(key, url);
  }

  return map;
}

function looksLikeNoteManagerCard(text: string): boolean {
  if (!text.trim()) return false;
  if (/发布于/.test(text)) return true;
  if (/编辑/.test(text) && /删除/.test(text)) return true;
  return text.length >= 8;
}

function findNoteManagerRows(): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const rows: HTMLElement[] = [];

  for (const el of document.querySelectorAll<HTMLElement>("[data-impression]")) {
    if (!isNoteCardImpressionElement(el)) continue;
    const card = el.classList.contains("note") ? el : getNoteCardRoot(el);
    if (!card.classList.contains("note")) continue;
    if (!parseNoteIdFromRow(card)) continue;
    const text = card.innerText || "";
    if (!looksLikeNoteManagerCard(text) && !extractTitleFromNoteCard(card)) continue;
    if (seen.has(card)) continue;
    seen.add(card);
    rows.push(card);
  }
  if (rows.length) return rows;

  for (const note of document.querySelectorAll<HTMLElement>(".note, [class*='note-card' i], [class*='NoteCard' i]")) {
    const text = note.innerText || "";
    if (!looksLikeNoteManagerCard(text)) continue;
    if (!parseNoteIdFromRow(note) && !note.querySelector("img")) continue;
    if (seen.has(note)) continue;
    seen.add(note);
    rows.push(note);
  }
  if (rows.length) return rows;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent || "";
    if (!/发布于\s*(\d{4}年\d{2}月\d{2}日|\d{4}-\d{2}-\d{2})/.test(text)) continue;
    let el = node.parentElement;
    for (let depth = 0; depth < 12 && el; depth++) {
      const card = getNoteCardRoot(el);
      const blob = card.innerText || "";
      if (blob.includes("编辑") && blob.includes("删除") && card.querySelector("img")) {
        if (!seen.has(card)) {
          seen.add(card);
          rows.push(card);
        }
        break;
      }
      el = el.parentElement;
    }
  }
  return rows;
}

/** 笔记管理：仅封面区域可跳转（无 a 标签，需模拟点击） */
function findNoteCoverClickTarget(row: HTMLElement): HTMLElement | null {
  const noteRoot = getNoteCardRoot(row);
  const selectors = [
    "div.note div.img",
    "div.note > div.img",
    ".note div.img",
    "motion.div.note div.img",
    "div.img",
    '[class*="cover" i]',
    ".media-body .img",
    ".note-cover"
  ];
  for (const sel of selectors) {
    const el = noteRoot.querySelector<HTMLElement>(sel);
    if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) return el;
  }
  const img = noteRoot.querySelector<HTMLImageElement>(
    "motion-div.img img, motion.div.img img, div.img img, .media-body img, img"
  );
  if (img && (img.offsetWidth > 0 || img.offsetHeight > 0)) return img;
  if (img?.parentElement instanceof HTMLElement) return img.parentElement;
  return img;
}

function findNoteRowByTitle(wantTitle: string): HTMLElement | undefined {
  for (const row of findNoteManagerRows()) {
    const root = getNoteCardRoot(row);
    const domTitle = extractTitleFromNoteCard(root);
    if (titleMatches(wantTitle, domTitle)) return row;
    const parsed = parseNoteManagerRowLoose(row, new Map());
    if (parsed && titleMatches(wantTitle, parsed.title)) return row;
  }
  return undefined;
}

function findNoteRowByNoteId(noteId: string): HTMLElement | undefined {
  const want = noteId.trim().toLowerCase();
  if (!want) return undefined;
  for (const row of findNoteManagerRows()) {
    const id = parseNoteIdFromRow(getNoteCardRoot(row));
    if (id && id.toLowerCase() === want) return row;
  }
  return undefined;
}

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

function isTrustedExploreUrl(url?: string): boolean {
  if (!url?.trim()) return false;
  if (isRejectedNoteUrl(url)) return false;
  if (!url.includes("/explore/")) return false;
  if (url.includes("xsec_token")) return true;
  if (/xsec_source=pc_creatormng/.test(url) && !url.includes("xsec_token")) return false;
  return false;
}

async function resolveLinksByCoverClick(
  items: Array<{ title: string; note_id?: string; official_url?: string }>,
  rowByKey: Map<string, HTMLElement>
): Promise<void> {
  for (const item of items) {
    item.official_url = undefined;
    const key = normPublishedTitleKey(item.title);
    const row = rowByKey.get(key) ?? findNoteRowByTitle(item.title);
    if (!row) continue;
    const clickEl = findNoteCoverClickTarget(row);
    if (!clickEl) continue;
    clickEl.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(200);
    const captured = await resolveExploreUrlByClick(clickEl);
    if (captured && isTrustedExploreUrl(captured)) {
      item.official_url = captured;
    }
    await sleep(700);
  }
}

function simulateCoverClick(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + Math.max(4, rect.width / 2);
  const cy = rect.top + Math.max(4, rect.height / 2);
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
    button: 0
  };
  for (const type of ["pointerover", "pointerenter", "pointerdown", "mousedown"] as const) {
    el.dispatchEvent(new MouseEvent(type, base));
  }
  for (const type of ["pointerup", "mouseup", "click"] as const) {
    el.dispatchEvent(new MouseEvent(type, base));
  }
  try {
    el.click();
  } catch {
    /* ignore */
  }
}

function findNoteManagerTitleClickTarget(row: HTMLElement): HTMLElement | null {
  const titled = row.querySelector<HTMLElement>(
    '[class*="title" i], [class*="name" i], .note-title, [data-testid*="title" i]'
  );
  if (titled) {
    const t = (titled.textContent || "").trim();
    if (t.length >= 4 && !/发布于/.test(t)) return titled;
  }

  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const el of row.querySelectorAll<HTMLElement>("span, div, p, a, h1, h2, h3, h4")) {
    const t = (el.textContent || "").trim();
    if (t.length < 4 || t.length > 120) continue;
    if (/发布于|权限设置|编辑|删除|置顶|取消置顶|查看修改|仅部分人可见/.test(t)) continue;
    if (/^\d+$/.test(t)) continue;
    if (el.querySelector("img")) continue;
    if (el.children.length > 3) continue;
    if (t.length > bestLen) {
      bestLen = t.length;
      best = el;
    }
  }
  return best;
}

function parseNoteManagerRowMetrics(lines: string[], publishIdx: number) {
  const nums: number[] = [];
  for (let i = publishIdx + 1; i < lines.length && nums.length < 5; i++) {
    const line = lines[i];
    if (/^(权限设置|置顶|取消置顶|编辑|删除|查看修改建议)/.test(line)) break;
    if (/^\d+$/.test(line)) nums.push(parseInt(line, 10));
  }
  return {
    watch_count: nums[0],
    comments: nums[1],
    likes: nums[2],
    favorites: nums[3],
    shares: nums[4]
  };
}

function parseNoteManagerRow(row: HTMLElement, urlByTitle: Map<string, string>) {
  const text = (row.innerText || "").trim();
  const noteRoot = getNoteCardRoot(row);
  const noteId = parseNoteIdFromRow(noteRoot);
  if (!text || (!looksLikeNoteManagerCard(text) && !noteId)) return null;

  const published_at = parsePublishedAtLoose(text);
  let publish_status = "published";
  if (/未通过/.test(text)) publish_status = "rejected";

  const lines = text
    .split(/\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const publishIdx = lines.findIndex((l) => /发布于/.test(l));

  let title = extractTitleFromNoteCard(noteRoot);
  if (title.length < 2) {
    for (let i = 0; i < (publishIdx >= 0 ? publishIdx : lines.length); i++) {
      const line = lines[i];
      if (line === "未通过" || /查看修改建议/.test(line)) continue;
      if (/^(权限设置|置顶|取消置顶|编辑|删除|仅部分人可见)/.test(line)) continue;
      if (/^\d+$/.test(line)) continue;
      const cleaned = line.replace(/^未通过\s*/, "").trim();
      if (cleaned.length > title.length) title = cleaned;
    }
  }
  if (!title || title.length < 2) return null;

  const metrics =
    publishIdx >= 0 ? parseNoteManagerRowMetrics(lines, publishIdx) : {};
  const key = normPublishedTitleKey(title);
  let official_url = extractExploreFromElement(noteRoot) || urlByTitle.get(key);
  if (official_url && !isTrustedExploreUrl(official_url)) official_url = undefined;
  const cover_url = noteRoot.querySelector("img")?.getAttribute("src") || undefined;

  return {
    title,
    published_at,
    publish_status,
    cover_url,
    note_id: noteId,
    official_url,
    ...metrics
  };
}

function parseNoteManagerRowLoose(row: HTMLElement, urlByTitle: Map<string, string>) {
  const parsed = parseNoteManagerRow(row, urlByTitle);
  if (parsed) return parsed;
  const noteRoot = getNoteCardRoot(row);
  const noteId = parseNoteIdFromRow(noteRoot);
  if (!noteId) return null;
  const text = (row.innerText || "").trim();
  const title = extractTitleFromNoteCard(noteRoot) || extractTitleFromNoteBlock(text, "");
  if (!title || title.length < 2) return null;
  const key = normPublishedTitleKey(title);
  return {
    title,
    published_at: parsePublishedAtLoose(text),
    publish_status: /未通过/.test(text) ? "rejected" : "published",
    cover_url: noteRoot.querySelector("img")?.getAttribute("src") || undefined,
    note_id: noteId,
    official_url: urlByTitle.get(key)
  };
}

function harvestNoteUrlsFromJson(value: unknown, urlByTitle: Map<string, string>, depth = 0) {
  if (depth > 14 || value == null) return;
  if (Array.isArray(value)) {
    for (const it of value) harvestNoteUrlsFromJson(it, urlByTitle, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  const title =
    ["display_title", "displayTitle", "title", "noteTitle", "note_title", "name"]
      .map((k) => (typeof o[k] === "string" ? (o[k] as string).trim() : ""))
      .find((t) => t.length >= 2) || "";
  const urlKeys = [
    "share_link",
    "shareLink",
    "note_link",
    "noteLink",
    "jump_url",
    "jumpUrl",
    "web_url",
    "webUrl",
    "link",
    "url",
    "note_url",
    "noteUrl"
  ];
  let official_url: string | undefined;
  for (const k of urlKeys) {
    if (typeof o[k] === "string") {
      official_url = normalizeExploreUrl(o[k] as string);
      if (official_url) break;
    }
  }
  const noteId =
    (typeof o.note_id === "string" && o.note_id) ||
    (typeof o.noteId === "string" && o.noteId) ||
    (typeof o.id === "string" && /^[a-f0-9]{16,}$/i.test(o.id) ? o.id : "");
  if (!official_url && noteId) {
    const xsecToken =
      (typeof o.xsec_token === "string" && o.xsec_token.trim()) ||
      (typeof o.xsecToken === "string" && o.xsecToken.trim()) ||
      "";
    if (xsecToken) {
      const xsecSource =
        (typeof o.xsec_source === "string" && o.xsec_source.trim()) ||
        (typeof o.xsecSource === "string" && o.xsecSource.trim()) ||
        "pc_creatormng";
      official_url = buildExploreUrlFromPostedFields(noteId, xsecToken, xsecSource);
    }
  }
  if (title && official_url) {
    const key = normPublishedTitleKey(title);
    const prev = urlByTitle.get(key);
    if (!prev || official_url.length > prev.length) urlByTitle.set(key, official_url);
  }
  for (const v of Object.values(o)) harvestNoteUrlsFromJson(v, urlByTitle, depth + 1);
}

function installNoteListNetworkHook(urlByTitle: Map<string, string>): () => void {
  const ingestText = (text: string) => {
    if (!text || text.length < 40) return;
    if (!/note|explore|title|笔记/i.test(text)) return;
    try {
      harvestNoteUrlsFromJson(JSON.parse(text), urlByTitle);
    } catch {
      for (const m of text.matchAll(
        /https?:\\?\/\\?\/www\.xiaohongshu\.com\/explore\/[a-f0-9]{16,}[^"'\\\s]*/gi
      )) {
        const url = normalizeExploreUrl(m[0].replace(/\\\//g, "/"));
        if (!url) continue;
        const idx = m.index ?? 0;
        const window = text.slice(Math.max(0, idx - 500), idx + 300);
        const titleM = window.match(/"(?:title|displayTitle)"\s*:\s*"((?:[^"\\]|\\.)+)"/i);
        if (titleM) {
          const title = decodeJsonStringLiteral(titleM[1]);
          const key = normPublishedTitleKey(title);
          const prev = urlByTitle.get(key);
          if (!prev || url.length > prev.length) urlByTitle.set(key, url);
        }
      }
    }
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await origFetch(...args);
    try {
      ingestText(await res.clone().text());
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
        const body = (this as XMLHttpRequest).responseText;
        if (typeof body === "string") ingestText(body);
      } catch {
        /* ignore */
      }
    });
    return origSend.apply(this, args as never);
  };

  return () => {
    window.fetch = origFetch;
    Xhr.open = origOpen;
    Xhr.send = origSend;
  };
}

async function resolveCreatorNoteLinkByTitle(title: string): Promise<string | undefined> {
  const key = normPublishedTitleKey(title);
  const urlByTitle = harvestNoteManagerUrlByTitle();
  for (const row of findNoteManagerRows()) {
    const parsed = parseNoteManagerRow(row, urlByTitle);
    if (!parsed || normPublishedTitleKey(parsed.title) !== key) continue;
    if (parsed.official_url?.includes("xsec_token")) return parsed.official_url;

    const clickEl = findNoteCoverClickTarget(row);
    if (clickEl) {
      const captured = await resolveExploreUrlByClick(clickEl);
      if (captured) return captured;
    }
    return parsed.official_url;
  }
  return undefined;
}

function findNoteLinkClickTarget(row: HTMLElement): HTMLElement | null {
  const cover = findNoteCoverClickTarget(row);
  if (cover) return cover;
  for (const a of row.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const label = (a.textContent || "").trim();
    if (/^(编辑|删除|权限设置|置顶|取消置顶|查看修改建议)$/.test(label)) continue;
    const u = normalizeExploreUrl(a.getAttribute("href") || a.href || "");
    if (u) return a;
  }
  return findNoteManagerTitleClickTarget(row);
}

async function resolveExploreUrlByClick(clickEl: HTMLElement): Promise<string | undefined> {
  let openedUrl: string | undefined;
  const origOpen = window.open;
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    if (typeof url === "string") {
      const normalized = normalizeExploreUrl(url);
      if (normalized && isTrustedExploreUrl(normalized)) {
        openedUrl = normalized;
      }
    }
    return origOpen.call(window, url as string, target, features);
  }) as typeof window.open;

  try {
    await chrome.runtime.sendMessage({
      channel: "XHS_PUBLISH_BRIDGE",
      action: "BEGIN_EXPLORE_CAPTURE",
      timeoutMs: 22000,
      returnUrl: location.href
    });
    await sleep(200);
    simulateCoverClick(clickEl);
    const noteRoot = clickEl.closest(".note") || clickEl.parentElement;
    if (noteRoot instanceof HTMLElement && noteRoot !== clickEl) {
      simulateCoverClick(noteRoot);
    }
    await sleep(400);
    const resp = (await chrome.runtime.sendMessage({
      channel: "XHS_PUBLISH_BRIDGE",
      action: "WAIT_EXPLORE_CAPTURE"
    })) as { ok?: boolean; url?: string } | undefined;
    const fromTab = resp?.ok && resp.url ? normalizeExploreUrl(resp.url) : undefined;
    if (fromTab && isTrustedExploreUrl(fromTab)) return fromTab;
    if (openedUrl && isTrustedExploreUrl(openedUrl)) return openedUrl;
  } catch {
    /* ignore */
  } finally {
    window.open = origOpen;
  }
  return undefined;
}

function isExploreNoteUrlLocal(url: string): boolean {
  return /xiaohongshu\.com\/explore\/[a-f0-9]{16,}/i.test(url) && !url.includes("creator.xiaohongshu.com");
}

function normPublishedTitleKey(title: string): string {
  return title
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase()
    .replace(/^未通过/, "");
}

function titleMatches(want: string, got: string): boolean {
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

/** 创作中心 · 笔记管理列表接口（tab=0 一般为全部笔记） */
const CREATOR_POSTED_API =
  "https://creator.xiaohongshu.com/api/galaxy/v2/creator/note/user/posted";

const postedApiCapturedPayloads: unknown[] = [];
let postedApiHookInstalled = false;

function isPostedApiUrl(url: string): boolean {
  return url.includes("/api/galaxy/v2/creator/note/user/posted");
}

function rememberPostedApiPayload(json: unknown): void {
  const arr = findPostedNoteArrayInPayload(json);
  if (!arr.length) return;
  postedApiCapturedPayloads.unshift(json);
  if (postedApiCapturedPayloads.length > 8) postedApiCapturedPayloads.length = 8;
}

function ensurePostedApiNetworkHook(): void {
  if (postedApiHookInstalled) return;
  postedApiHookInstalled = true;

  const ingestPostedBody = (text: string, url: string) => {
    if (!text || text.length < 40 || !isPostedApiUrl(url)) return;
    try {
      rememberPostedApiPayload(JSON.parse(text));
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
      ingestPostedBody(await res.clone().text(), reqUrl);
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
        if (typeof body === "string") ingestPostedBody(body, xhrUrl);
      } catch {
        /* ignore */
      }
    });
    return origSend.apply(this, args as never);
  };
}

function postedRowsFromCapturedPayloads(): PostedApiNoteRow[] {
  const items: PostedApiNoteRow[] = [];
  const seen = new Set<string>();
  for (const json of postedApiCapturedPayloads) {
    for (const raw of findPostedNoteArrayInPayload(json)) {
      const row = parsePostedApiNoteItem(raw);
      if (!row) continue;
      const key = row.note_id || normPublishedTitleKey(row.title);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(row);
    }
  }
  return items;
}

async function loadMorePostedPagesViaScroll(): Promise<void> {
  const scrollables: HTMLElement[] = [];
  for (const sel of [
    "[class*='note-list']",
    "[class*='NoteList']",
    ".note-manager",
    "main",
    "#app"
  ]) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.scrollHeight > el.clientHeight + 80) scrollables.push(el);
  }
  for (let round = 0; round < 12; round++) {
    window.scrollTo(0, document.body.scrollHeight);
    for (const el of scrollables) {
      el.scrollTop = el.scrollHeight;
    }
    await sleep(650);
  }
  window.scrollTo(0, 0);
  await sleep(400);
  window.scrollTo(0, document.body.scrollHeight);
  await sleep(800);
}

function postedPayloadsNoteStats(mainPayloads?: unknown[]): {
  collected: number;
  total?: number;
  pagesSeen: number;
} {
  const sources: unknown[] = [];
  if (mainPayloads?.length) sources.push(...mainPayloads);
  for (const p of postedApiCapturedPayloads) {
    if (!sources.includes(p)) sources.push(p);
  }

  const ids = new Set<string>();
  let total: number | undefined;

  for (const json of sources) {
    if (!json || typeof json !== "object") continue;
    const root = json as Record<string, unknown>;
    const data =
      root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
    const tags = data.tags;
    if (Array.isArray(tags)) {
      for (const t of tags) {
        if (!t || typeof t !== "object") continue;
        const n = (t as Record<string, unknown>).notes_count;
        if (typeof n === "number" && n > 0) total = Math.max(total ?? 0, n);
      }
    }
    for (const raw of findPostedNoteArrayInPayload(json)) {
      const id =
        (typeof raw.id === "string" && /^[a-f0-9]{16,}$/i.test(raw.id) && raw.id) ||
        (typeof raw.note_id === "string" && raw.note_id) ||
        "";
      if (id) ids.add(String(id).toLowerCase());
    }
  }

  return { collected: ids.size, total, pagesSeen: sources.length };
}

async function warmPostedApiCacheOnPage(loadAllPages = false): Promise<number> {
  ensurePostedApiNetworkHook();
  if (!location.hostname.includes("creator.xiaohongshu.com")) return 0;
  if (!location.pathname.includes("note-manager")) return postedRowsFromCapturedPayloads().length;
  await clickNoteManagerTab("all");
  await sleep(800);
  await clickNoteManagerTab("published");
  await scrollNoteManagerList(3);
  if (loadAllPages) {
    await loadMorePostedPagesViaScroll();
    await sleep(1200);
  } else {
    await sleep(2800);
  }
  return postedRowsFromCapturedPayloads().length;
}

if (location.hostname.includes("xiaohongshu.com")) {
  ensurePostedApiNetworkHook();
}

type PostedApiNoteRow = {
  title: string;
  note_id?: string;
  official_url?: string;
  published_at?: string;
  cover_url?: string;
  publish_status?: string;
  watch_count?: number;
  likes?: number;
  comments?: number;
  favorites?: number;
  shares?: number;
};

/** 创作中心 posted 接口：id + xsec_token 拼 explore 链接（与点封面打开一致） */
function buildExploreUrlFromPostedFields(
  noteId: string,
  xsecToken: string,
  xsecSource?: string
): string | undefined {
  const id = noteId.trim().toLowerCase();
  const token = xsecToken.trim();
  if (!/^[a-f0-9]{16,}$/i.test(id) || !token) return undefined;
  const params = new URLSearchParams();
  params.set("xsec_token", token);
  params.set("xsec_source", (xsecSource || "pc_creatormng").trim() || "pc_creatormng");
  return `https://www.xiaohongshu.com/explore/${id}?${params.toString()}`;
}

function extractExploreUrlWithTokenFromValue(value: unknown, depth = 0): string | undefined {
  if (depth > 12 || value == null) return undefined;
  if (typeof value === "string") {
    if (!value.includes("/explore/") || !value.includes("xsec_token")) return undefined;
    const u = normalizeExploreUrl(value);
    return u && u.includes("xsec_token") ? u : undefined;
  }
  if (Array.isArray(value)) {
    for (const it of value) {
      const u = extractExploreUrlWithTokenFromValue(it, depth + 1);
      if (u) return u;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const u = extractExploreUrlWithTokenFromValue(v, depth + 1);
      if (u) return u;
    }
  }
  return undefined;
}

function parsePostedApiNoteItem(raw: Record<string, unknown>): PostedApiNoteRow | null {
  const title =
    ["display_title", "displayTitle", "title", "note_title", "noteTitle", "name"]
      .map((k) => (typeof raw[k] === "string" ? (raw[k] as string).trim() : ""))
      .find((t) => t.length >= 2) || "";
  if (!title) return null;

  const noteIdRaw =
    (typeof raw.note_id === "string" && raw.note_id) ||
    (typeof raw.noteId === "string" && raw.noteId) ||
    (typeof raw.id === "string" && /^[a-f0-9]{16,}$/i.test(raw.id) ? raw.id : "");
  const note_id = noteIdRaw ? noteIdRaw.toLowerCase() : undefined;

  const urlKeys = [
    "share_link",
    "shareLink",
    "note_link",
    "noteLink",
    "jump_url",
    "jumpUrl",
    "web_url",
    "webUrl",
    "link",
    "url",
    "note_url",
    "noteUrl",
    "share_url",
    "shareUrl",
    "permalink",
    "note_share_link",
    "noteShareLink"
  ];
  let official_url: string | undefined;
  for (const k of urlKeys) {
    if (typeof raw[k] === "string") {
      const u = normalizeExploreUrl(raw[k] as string);
      if (u && u.includes("xsec_token")) {
        official_url = u;
        break;
      }
    }
  }
  if (!official_url) official_url = extractExploreUrlWithTokenFromValue(raw);
  if (!official_url && note_id) {
    const xsecToken =
      (typeof raw.xsec_token === "string" && raw.xsec_token.trim()) ||
      (typeof raw.xsecToken === "string" && raw.xsecToken.trim()) ||
      "";
    const xsecSource =
      (typeof raw.xsec_source === "string" && raw.xsec_source.trim()) ||
      (typeof raw.xsecSource === "string" && raw.xsecSource.trim()) ||
      "pc_creatormng";
    if (xsecToken) {
      official_url = buildExploreUrlFromPostedFields(note_id, xsecToken, xsecSource);
    }
  }

  let published_at: string | undefined;
  for (const k of ["publish_time", "publishTime", "time", "create_time", "createTime", "posted_at"]) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) {
      published_at = v.trim();
      break;
    }
    if (typeof v === "number" && v > 1e9) {
      published_at = new Date(v > 1e12 ? v : v * 1000).toISOString();
      break;
    }
  }

  let cover_url =
    (typeof raw.cover_url === "string" && raw.cover_url) ||
    (typeof raw.coverUrl === "string" && raw.coverUrl) ||
    (typeof raw.image === "string" && raw.image) ||
    undefined;
  if (!cover_url) {
    const imagesList = raw.images_list ?? raw.imagesList;
    if (Array.isArray(imagesList) && imagesList[0] && typeof imagesList[0] === "object") {
      const firstUrl = (imagesList[0] as Record<string, unknown>).url;
      if (typeof firstUrl === "string" && firstUrl.trim()) cover_url = firstUrl.trim();
    }
  }

  let publish_status = "published";
  const tabStatus = raw.tab_status ?? raw.tabStatus;
  const punish =
    (typeof raw.punish_reason === "string" && raw.punish_reason) ||
    (typeof raw.punishReason === "string" && raw.punishReason) ||
    "";
  if (tabStatus === 3 || punish.trim()) publish_status = "rejected";
  const st = raw.status ?? raw.note_status ?? raw.noteStatus ?? raw.audit_status;
  if (typeof st === "string") {
    if (/未通过|拒绝|reject/i.test(st)) publish_status = "rejected";
    else if (/审核|review/i.test(st)) publish_status = "reviewing";
  } else if (typeof st === "number") {
    if (st === 2 || st === -1) publish_status = "rejected";
  }

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  return {
    title,
    note_id,
    official_url: official_url && isTrustedExploreUrl(official_url) ? official_url : undefined,
    published_at,
    cover_url,
    publish_status,
    watch_count: num(raw.view_count ?? raw.viewCount),
    likes: num(raw.likes),
    comments: num(raw.comments_count ?? raw.commentsCount),
    favorites: num(raw.collected_count ?? raw.collectedCount),
    shares: num(raw.shared_count ?? raw.sharedCount)
  };
}

function looksLikePostedNoteObject(o: Record<string, unknown>): boolean {
  const hasTitle = ["title", "display_title", "displayTitle", "note_title"].some(
    (k) => typeof o[k] === "string" && (o[k] as string).trim().length >= 2
  );
  const hasId =
    (typeof o.note_id === "string" && /^[a-f0-9]{16,}$/i.test(o.note_id)) ||
    (typeof o.noteId === "string" && /^[a-f0-9]{16,}$/i.test(o.noteId)) ||
    (typeof o.id === "string" && /^[a-f0-9]{16,}$/i.test(o.id));
  const hasXsec =
    (typeof o.xsec_token === "string" && (o.xsec_token as string).trim().length > 0) ||
    (typeof o.xsecToken === "string" && (o.xsecToken as string).trim().length > 0);
  const hasLink = Boolean(extractExploreUrlWithTokenFromValue(o)) || (hasId && hasXsec);
  return hasTitle && (hasId || hasLink);
}

function findPostedNoteArrayInPayload(json: unknown): Record<string, unknown>[] {
  if (json && typeof json === "object") {
    const data = (json as Record<string, unknown>).data;
    if (data && typeof data === "object") {
      const notes = (data as Record<string, unknown>).notes;
      if (Array.isArray(notes)) {
        return notes.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
      }
    }
  }

  const candidates: Record<string, unknown>[][] = [];

  const visit = (value: unknown, depth: number) => {
    if (depth > 10 || value == null) return;
    if (Array.isArray(value)) {
      const objs = value.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
      if (objs.length && objs.some(looksLikePostedNoteObject)) candidates.push(objs);
      for (const it of objs) visit(it, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) visit(v, depth + 1);
    }
  };
  visit(json, 0);

  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || [];
}

const POSTED_API_PAGE_SIZE = 10;

function apiResponseHasMore(json: unknown, batchSize: number): boolean {
  if (!json || typeof json !== "object") return false;
  const root = json as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  for (const k of ["has_more", "hasMore", "more", "has_next", "hasNext"]) {
    if (data[k] === true) return true;
    if (data[k] === false) return false;
  }
  if (batchSize < POSTED_API_PAGE_SIZE) return false;
  const total = data.total ?? data.total_count ?? data.totalCount;
  if (typeof total === "number" && batchSize > 0) {
    const tags = data.tags;
    if (Array.isArray(tags)) {
      const allTag = tags.find(
        (t) =>
          t &&
          typeof t === "object" &&
          typeof (t as Record<string, unknown>).notes_count === "number"
      ) as Record<string, unknown> | undefined;
      if (allTag && typeof allTag.notes_count === "number") {
        return batchSize < allTag.notes_count;
      }
    }
  }
  return batchSize >= POSTED_API_PAGE_SIZE;
}

function ingestExternalPostedPayloads(payloads: unknown[]): void {
  for (const p of payloads) rememberPostedApiPayload(p);
}

async function fetchCreatorPostedNotesFromApi(
  limit: number,
  tab = 0,
  extraPayloads: unknown[] = []
): Promise<{
  ok: boolean;
  items: PostedApiNoteRow[];
  pages?: number;
  error?: string;
  detail?: string;
  source?: string;
  apiError?: string;
}> {
  ensurePostedApiNetworkHook();
  ingestExternalPostedPayloads(extraPayloads);

  const items: PostedApiNoteRow[] = [];
  const seen = new Set<string>();
  const maxPages = 25;
  let page = 0;
  let source: string | undefined;
  let apiError: string | undefined;

  const mergeRows = (rows: PostedApiNoteRow[]) => {
    for (const row of rows) {
      const key = row.note_id || normPublishedTitleKey(row.title);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(row);
      if (items.length >= limit) break;
    }
  };

  const cached = postedRowsFromCapturedPayloads();
  if (cached.length) {
    mergeRows(cached);
    source = extraPayloads.length ? "posted_api_main_capture" : "posted_api_page_cache";
  }

  const statsAfterCache = postedPayloadsNoteStats(extraPayloads);
  const skipDirectFetch =
    extraPayloads.length > 0 &&
    items.length > 0 &&
    (statsAfterCache.total == null || items.length >= statsAfterCache.total);

  while (!skipDirectFetch && page < maxPages && items.length < limit) {
    const url = `${CREATOR_POSTED_API}?tab=${tab}&page=${page}`;
    let res: Response;
    try {
      res = await fetch(url, {
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          "x-requested-with": "XMLHttpRequest",
          referer: "https://creator.xiaohongshu.com/new/note-manager?source=official"
        }
      });
    } catch (e) {
      apiError = String(e);
      break;
    }

    if (!res.ok) {
      apiError = `HTTP ${res.status}（扩展直连会被风控，已改读页面自带请求）`;
      break;
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      return { ok: false, items, error: "api_json_error", detail: String(e) };
    }

    const root = json as Record<string, unknown>;
    const code = root.code ?? root.status_code ?? root.statusCode;
    if (code != null && code !== 0 && code !== 200 && code !== "0") {
      const msg = typeof root.msg === "string" ? root.msg : typeof root.message === "string" ? root.message : "";
      apiError = `${String(code)} ${msg}`.trim();
      rememberPostedApiPayload(json);
      break;
    }

    rememberPostedApiPayload(json);
    const arr = findPostedNoteArrayInPayload(json);
    if (!arr.length) break;

    const pageRows: PostedApiNoteRow[] = [];
    for (const raw of arr) {
      const row = parsePostedApiNoteItem(raw);
      if (row) pageRows.push(row);
    }
    mergeRows(pageRows);
    if (!source) source = "posted_api_fetch";

    if (items.length >= limit) break;
    if (!apiResponseHasMore(json, arr.length)) break;
    page += 1;
    await sleep(280);
  }

  if (!items.length) {
    const hint = extraPayloads.length
      ? "页面拦截到 posted 响应但解析失败"
      : "未拦截到 posted 响应（请在笔记管理页刷新后重试）";
    return {
      ok: false,
      items: [],
      error: "api_empty",
      detail: apiError ? `${hint}：${apiError}` : hint,
      source,
      apiError
    };
  }

  return {
    ok: true,
    items,
    pages: page + 1,
    source,
    apiError: items.some((x) => x.official_url?.includes("xsec_token")) ? undefined : apiError
  };
}

function matchPostedRowsToTitles(
  items: PostedApiNoteRow[],
  matchTitles: string[]
): PostedApiNoteRow[] {
  const out: PostedApiNoteRow[] = [];
  const used = new Set<string>();
  for (const want of matchTitles) {
    const hit = items.find((x) => titleMatches(want, x.title));
    if (!hit) continue;
    const key = hit.note_id || normPublishedTitleKey(hit.title);
    if (used.has(key)) continue;
    used.add(key);
    out.push({ ...hit, title: want });
  }
  return out;
}

function titleSimilarity(want: string, got: string): number {
  const a = normPublishedTitleKey(want);
  const b = normPublishedTitleKey(got);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const prefixLen = Math.min(16, a.length, b.length);
  if (prefixLen >= 4 && a.slice(0, prefixLen) === b.slice(0, prefixLen)) return 0.75;
  let common = 0;
  const setB = new Set(b);
  for (const ch of a) if (setB.has(ch)) common += 1;
  return common / Math.max(a.length, b.length, 1);
}

function findBestTitleMatch<T extends { title: string }>(want: string, candidates: T[]): T | undefined {
  let best: T | undefined;
  let bestScore = 0.24;
  for (const c of candidates) {
    if (titleMatches(want, c.title)) return c;
    const score = titleSimilarity(want, c.title);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function matchTitlesFromCatalog(
  matchTitles: string[],
  catalog?: ImpressionNoteMeta[]
): Array<{
  title: string;
  note_id: string;
  official_url: string;
}> {
  const impressions = catalog ?? harvestNoteCatalog();
  const out: Array<{ title: string; note_id: string; official_url: string }> = [];
  const used = new Set<string>();
  for (const want of matchTitles) {
    const hit = findBestTitleMatch(want, impressions.filter((x) => x.title.length >= 2));
    if (!hit || used.has(hit.noteId)) continue;
    used.add(hit.noteId);
    out.push({
      title: want,
      note_id: hit.noteId,
      official_url: ""
    });
  }
  return out;
}

function isNoteManagerAllTabActive(): boolean {
  const tabs = document.querySelectorAll<HTMLElement>(
    "[role='tab'], [role='tablist'] [class*='tab'], [class*='Tab']"
  );
  for (const el of tabs) {
    const t = (el.textContent || "").replace(/\s+/g, "");
    if (!t.startsWith("全部笔记") && t !== "全部" && !t.startsWith("全部(")) continue;
    const selected =
      el.getAttribute("aria-selected") === "true" ||
      el.classList.contains("active") ||
      el.classList.contains("is-active") ||
      Boolean(el.closest(".active, .is-active, [aria-selected='true']"));
    if (selected) return true;
  }
  return false;
}

async function clickNoteManagerTab(mode: "all" | "published" | "none"): Promise<void> {
  if (mode === "none") return;
  if (mode === "all" && isNoteManagerAllTabActive()) return;

  const roots: HTMLElement[] = [];
  for (const sel of ["[role='tablist']", ".d-tabs", ".tabs", "header"]) {
    const root = document.querySelector<HTMLElement>(sel);
    if (root) roots.push(root);
  }
  if (!roots.length) roots.push(document.body);

  for (const root of roots) {
    const clickables = Array.from(
      root.querySelectorAll<HTMLElement>("button, [role='tab'], [role='button'], div, span, a, li")
    );
    for (const el of clickables) {
      const t = (el.textContent || "").replace(/\s+/g, "");
      if (mode === "all") {
        if (
          t.startsWith("全部笔记") ||
          t === "全部" ||
          t.startsWith("全部(") ||
          t.startsWith("所有笔记")
        ) {
          el.click();
          await sleep(600);
          return;
        }
        continue;
      }
      if (
        t === "已发布" ||
        t.startsWith("已发布(") ||
        t.startsWith("已发布笔记") ||
        t.startsWith("发布成功")
      ) {
        el.click();
        await sleep(600);
        return;
      }
    }
  }
}

function extractTitleFromNoteBlock(text: string, anchorText: string): string {
  const lines = text
    .split(/\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  let title = "";
  for (const line of lines) {
    if (/发布于|发布时间|^\d{4}[-/]/.test(line)) continue;
    if (/^(已发布|未通过|审核中|草稿|查看|编辑|删除|数据|更多|笔记数据|详情)/.test(line)) continue;
    if (line.includes("查看修改建议")) continue;
    if (/^[\d.,+%\-+sS]+$/.test(line.replace(/\s/g, ""))) continue;
    if (line.length < 2) continue;
    const cleaned = line.replace(/^未通过\s*/, "").trim();
    if (cleaned.length > title.length) title = cleaned;
  }
  if (!title && anchorText.trim().length >= 2) {
    title = anchorText.trim().replace(/^未通过\s*/, "");
  }
  return title;
}

async function scrollNoteManagerList(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(500);
  }
  window.scrollTo(0, 0);
  await sleep(400);
}

/** 仅匹配标题+noteId（快速，不点封面；点封面由 background 逐条执行） */
async function scrapeCreatorNoteCatalogOnly(limit: number, matchTitles: string[]) {
  await sleep(400);
  await clickNoteManagerTab("none");
  await scrollNoteManagerList(2);
  let catalog = harvestNoteCatalog();
  let items = matchTitlesFromCatalog(matchTitles, catalog);
  if (items.length < matchTitles.length) {
    await clickNoteManagerTab("all");
    await scrollNoteManagerList(3);
    await sleep(500);
    catalog = harvestNoteCatalog();
    items = matchTitlesFromCatalog(matchTitles, catalog);
  }

  if (!items.length) {
    const rowByKey = new Map<string, HTMLElement>();
    const byKey = new Map<string, { title: string; note_id?: string }>();
    for (const row of findNoteManagerRows()) {
      const parsed = parseNoteManagerRowLoose(row, new Map());
      if (!parsed?.note_id) continue;
      const hit = findBestTitleMatch(parsed.title, matchTitles.map((t) => ({ title: t })));
      if (!hit) continue;
      const wantTitle = hit.title;
      const key = normPublishedTitleKey(wantTitle);
      rowByKey.set(key, row);
      byKey.set(key, { title: wantTitle, note_id: parsed.note_id });
    }
    items = Array.from(byKey.values()).map((x) => ({
      title: x.title,
      note_id: x.note_id || "",
      official_url: ""
    }));
  }

  return items.slice(0, limit);
}

/** 创作服务平台 · 笔记管理：按列表 DOM 解析标题/指标，并解析 explore 链接 */
async function scrapeCreatorNoteManagerLinks(
  limit: number,
  resolveLinksByClick = true,
  matchTitles?: string[]
) {
  if (matchTitles?.length) {
    return scrapeCreatorNoteCatalogOnly(limit, matchTitles);
  }

  const urlByTitle = harvestNoteManagerUrlByTitle();
  const unhookNetwork = installNoteListNetworkHook(urlByTitle);

  await sleep(600);
  await clickNoteManagerTab("published");
  for (let round = 0; round < 2; round++) {
    await scrollNoteManagerList(2);
    await sleep(500);
    if (findNoteManagerRows().length > 0) break;
    await clickNoteManagerTab("published");
  }
  harvestNoteManagerUrlByTitle().forEach((v, k) => {
    const prev = urlByTitle.get(k);
    if (!prev || v.length > prev.length) urlByTitle.set(k, v);
  });
  let rows = findNoteManagerRows();
  for (let i = 0; rows.length === 0 && i < 8; i++) {
    await sleep(800);
    await scrollNoteManagerList(2);
    rows = findNoteManagerRows();
  }
  const rowByKey = new Map<string, HTMLElement>();
  const byKey = new Map<
    string,
    {
      title: string;
      note_id?: string;
      official_url?: string;
      published_at?: string;
      cover_url?: string;
      publish_status?: string;
      watch_count?: number;
      comments?: number;
      likes?: number;
      favorites?: number;
      shares?: number;
    }
  >();

  for (const row of rows) {
    const parsed = parseNoteManagerRowLoose(row, urlByTitle);
    if (!parsed) continue;

    const key = normPublishedTitleKey(parsed.title);
    rowByKey.set(key, row);
    const prev = byKey.get(key);
    if (!prev || (parsed.title.length >= prev.title.length && !prev.official_url)) {
      byKey.set(key, parsed);
    }
  }

  let items = Array.from(byKey.values()).slice(0, limit);

  if (!resolveLinksByClick) {
    return items.filter((x) => x.title && (x.note_id || x.official_url));
  }

  let clickBudget = Math.min(
    items.filter((x) => !x.official_url?.includes("xsec_token")).length,
    16
  );
  for (const item of items) {
    if (clickBudget <= 0) break;
    if (item.official_url?.includes("xsec_token")) continue;

    const row = rowByKey.get(normPublishedTitleKey(item.title));
    if (!row) continue;
    const clickEl = findNoteCoverClickTarget(row);
    if (!clickEl) continue;

    const captured = await resolveExploreUrlByClick(clickEl);
    clickBudget -= 1;
    if (captured && isTrustedExploreUrl(captured)) {
      item.official_url = captured;
    }
    await sleep(520);
  }

  unhookNetwork();
  return items;
}

async function scrapeCreatorPublishedNotes(limit: number) {
  await sleep(1200);
  const clickables = Array.from(
    document.querySelectorAll<HTMLElement>("button, [role='tab'], div, span, a")
  );
  for (const el of clickables) {
    const t = (el.textContent || "").replace(/\s+/g, "");
    if (t === "笔记数据" || t.startsWith("笔记数据")) {
      el.click();
      await sleep(900);
      break;
    }
  }

  const items: {
    title: string;
    published_at?: string;
    publish_status?: string;
    cover_url?: string;
    official_url?: string;
    impressions?: number;
    watch_count?: number;
    click_rate_pct?: number;
    likes?: number;
    comments?: number;
    favorites?: number;
    follower_gain?: number;
    shares?: number;
    avg_watch_seconds?: number;
  }[] = [];

  const trs = Array.from(document.querySelectorAll("table tbody tr")).filter((tr) =>
    /发布于\s*\d{4}-\d{2}-\d{2}/.test(tr.textContent || "")
  );

  const rows = trs.length
    ? trs
    : Array.from(document.querySelectorAll<HTMLElement>("tr, [role='row'], div")).filter((el) =>
        /发布于\s*\d{4}-\d{2}-\d{2}/.test(el.innerText || "")
      );

  const seen = new Set<string>();
  for (const row of rows) {
    const tds = row.querySelectorAll("td");
    const infoCell = tds.length ? (tds[0] as HTMLElement) : row;
    const infoText = (infoCell.innerText || "").trim();
    if (!infoText || !/发布于/.test(infoText)) continue;

    const published_at = parsePublishedAtFromText(infoText);
    let publish_status = "published";
    if (/未通过/.test(infoText)) publish_status = "rejected";

    const lines = infoText
      .split(/\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    let title = "";
    for (const line of lines) {
      if (/发布于/.test(line)) continue;
      if (line === "未通过" || line.includes("查看修改建议")) continue;
      if (/详情数据/.test(line)) continue;
      if (/^[\d.,+%\-+sS]+$/.test(line.replace(/\s/g, ""))) continue;
      if (line.length < 2) continue;
      title = line.replace(/^未通过\s*/, "").trim();
      break;
    }
    if (!title) continue;

    const key = `${title}|${published_at || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const coverImg = infoCell.querySelector("img");
    const cover_url = coverImg?.getAttribute("src") || undefined;
    let official_url = extractExploreFromElement(infoCell);

    const metricCells = tds.length > 1 ? Array.from(tds).slice(1) : [];
    const metricTexts = metricCells.map((td) => (td.textContent || "").trim()).filter(Boolean);

    let impressions: number | undefined;
    let watch_count: number | undefined;
    let click_rate_pct: number | undefined;
    let likes: number | undefined;
    let comments: number | undefined;
    let favorites: number | undefined;
    let follower_gain: number | undefined;
    let shares: number | undefined;
    let avg_watch_seconds: number | undefined;

    if (metricTexts.length >= 8) {
      impressions = parseMetricInt(metricTexts[0]);
      watch_count = parseMetricInt(metricTexts[1]);
      click_rate_pct = parseMetricPct(metricTexts[2]);
      likes = parseMetricInt(metricTexts[3]);
      comments = parseMetricInt(metricTexts[4]);
      favorites = parseMetricInt(metricTexts[5]);
      follower_gain = parseMetricInt(metricTexts[6]);
      shares = parseMetricInt(metricTexts[7]);
      if (metricTexts[8]) avg_watch_seconds = parseWatchSeconds(metricTexts[8]);
    } else {
      const nums: number[] = [];
      const pcts: number[] = [];
      const secs: number[] = [];
      for (const line of lines) {
        const p = parseMetricPct(line);
        if (p != null) {
          pcts.push(p);
          continue;
        }
        const sec = parseWatchSeconds(line);
        if (sec != null) {
          secs.push(sec);
          continue;
        }
        const n = parseMetricInt(line);
        if (n != null) nums.push(n);
      }
      if (nums.length >= 2) {
        impressions = nums[0];
        watch_count = nums[1];
        likes = nums[2];
        comments = nums[3];
        favorites = nums[4];
        follower_gain = nums[5];
        shares = nums[6];
      }
      if (pcts.length) click_rate_pct = pcts[0];
      if (secs.length) avg_watch_seconds = secs[0];
    }

    items.push({
      title,
      published_at,
      publish_status,
      cover_url,
      official_url,
      impressions,
      watch_count,
      click_rate_pct,
      likes,
      comments,
      favorites,
      follower_gain,
      shares,
      avg_watch_seconds
    });
    if (items.length >= limit) break;
  }

  return items;
}
