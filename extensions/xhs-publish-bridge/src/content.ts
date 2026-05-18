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

  sendResponse({ ok: false, detail: "unsupported_inner_action" });
  return false;
});
