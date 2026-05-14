/// <reference types="chrome" />

type RunPayload = { prompt: string; params?: Record<string, unknown> };

type GeminiDomImage = { mime: string; content_base64: string };

type GeminiDomResult =
  | { ok: true; images: GeminiDomImage[]; detail?: string }
  | { ok: false; error: string; detail?: string };

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
  }
  return btoa(binary);
}

async function srcToImagePayload(src: string): Promise<GeminiDomImage | null> {
  if (src.startsWith("data:image/")) {
    const i = src.indexOf(";base64,");
    if (i === -1) return null;
    const mime = src.slice(5, i) || "image/png";
    const b64 = src.slice(i + 8).trim();
    if (!b64) return null;
    return { mime, content_base64: b64 };
  }
  if (src.startsWith("blob:") || src.startsWith("https://") || src.startsWith("http://")) {
    try {
      const res = await fetch(src, { credentials: "include" });
      if (!res.ok) return null;
      const blob = await res.blob();
      const mime = blob.type && blob.type.startsWith("image/") ? blob.type.split(";")[0].trim() : "image/png";
      const buf = await blob.arrayBuffer();
      if (buf.byteLength < 32 || buf.byteLength > 8 * 1024 * 1024) return null;
      return { mime, content_base64: uint8ToBase64(new Uint8Array(buf)) };
    } catch {
      return null;
    }
  }
  return null;
}

function collectMainImageSrcs(): string[] {
  const main = document.querySelector("main");
  if (!main) return [];
  const imgs = main.querySelectorAll("img[src]");
  const seen = new Set<string>();
  const out: string[] = [];
  imgs.forEach((el) => {
    const s = (el as HTMLImageElement).getAttribute("src") || "";
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  });
  return out;
}

function filterParamsForPrompt(params: Record<string, unknown>): Record<string, unknown> {
  const internal = new Set(["chrome_cdp_url", "chrome_profile_dir", "apiBaseUrl", "bearerToken", "sessionId"]);
  return Object.fromEntries(Object.entries(params).filter(([k]) => !internal.has(k)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = window.getComputedStyle(el);
  if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return false;
  return true;
}

function dispatchInputLike(el: HTMLElement, text: string): void {
  try {
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, data: text, inputType: "insertText" }),
    );
  } catch {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Gemini 发送多为圆形箭头按钮，不一定是 type=submit。 */
function findGeminiSendButton(input: HTMLElement): HTMLButtonElement | null {
  const sendLabel = /send|submit|发送|提交|run/i;

  const tryBtn = (b: HTMLButtonElement): boolean => {
    if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
    if (!isVisible(b)) return false;
    const aria = (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "");
    if (sendLabel.test(aria)) return true;
    return false;
  };

  let node: HTMLElement | null = input;
  for (let depth = 0; depth < 14 && node; depth++, node = node.parentElement) {
    const buttons = Array.from(node.querySelectorAll("button")).filter((x): x is HTMLButtonElement => x instanceof HTMLButtonElement);
    const labeled = buttons.filter((b) => tryBtn(b));
    if (labeled.length === 1) return labeled[0];
    if (labeled.length > 1) {
      labeled.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
      return labeled[0];
    }
  }

  const globalLabeled = Array.from(document.querySelectorAll("button")).filter(
    (b): b is HTMLButtonElement => b instanceof HTMLButtonElement && tryBtn(b),
  );
  if (globalLabeled.length === 1) return globalLabeled[0];
  if (globalLabeled.length > 1) {
    globalLabeled.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return globalLabeled[0];
  }

  node = input;
  for (let depth = 0; depth < 14 && node; depth++, node = node.parentElement) {
    const buttons = Array.from(node.querySelectorAll("button")).filter(
      (b): b is HTMLButtonElement =>
        b instanceof HTMLButtonElement && !b.disabled && b.getAttribute("aria-disabled") !== "true" && isVisible(b),
    );
    if (buttons.length === 0) continue;
    const ir = input.getBoundingClientRect();
    const inBar = buttons.filter((b) => {
      const br = b.getBoundingClientRect();
      return br.top >= ir.top - 8 && Math.abs(br.bottom - ir.bottom) < 72;
    });
    const pool = inBar.length ? inBar : buttons;
    pool.sort((a, b) => {
      const da = Math.hypot(a.getBoundingClientRect().right - ir.right, a.getBoundingClientRect().bottom - ir.bottom);
      const db = Math.hypot(b.getBoundingClientRect().right - ir.right, b.getBoundingClientRect().bottom - ir.bottom);
      return da - db;
    });
    const pick = pool[0];
    if (pick && pick !== input) return pick;
  }

  const submit = document.querySelector("button[type='submit']") as HTMLButtonElement | null;
  if (submit && !submit.disabled && isVisible(submit)) return submit;

  return null;
}

async function clickSendOrEnter(input: HTMLElement): Promise<void> {
  await sleep(80);
  let btn = findGeminiSendButton(input);
  if (btn?.disabled) {
    await sleep(200);
    btn = findGeminiSendButton(input);
  }
  if (btn && !btn.disabled) {
    try {
      btn.focus();
      btn.click();
    } catch {
      /* ignore */
    }
    return;
  }
  if (input instanceof HTMLTextAreaElement) {
    for (const key of ["Enter", "Enter"]) {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key, code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key, code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      );
    }
    return;
  }
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }),
  );
}

function pickPromptSurface(): HTMLElement | null {
  const tas = Array.from(document.querySelectorAll("textarea")).filter(
    (t): t is HTMLTextAreaElement => t instanceof HTMLTextAreaElement && isVisible(t),
  );
  for (const t of tas) {
    if (t.offsetParent !== null) return t;
  }
  if (tas.length) return tas[tas.length - 1];

  const ces = Array.from(document.querySelectorAll("[contenteditable='true']")).filter(
    (e): e is HTMLElement => e instanceof HTMLElement && isVisible(e),
  );
  if (ces.length === 0) return null;
  if (ces.length === 1) return ces[0];
  ces.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const area = (r: DOMRect) => r.width * r.height;
    return rb.bottom - ra.bottom || area(rb) - area(ra);
  });
  return ces[0];
}

async function runTurnDom(payload: RunPayload): Promise<GeminiDomResult> {
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) return { ok: false, error: "missing_prompt" };

  const rawParams =
    payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
      ? (payload.params as Record<string, unknown>)
      : {};
  const params = filterParamsForPrompt(rawParams);

  let promptToSend = prompt;
  if (Object.keys(params).length > 0) {
    promptToSend = `${prompt}\n\nPARAMS_JSON:\n${JSON.stringify(params)}`;
  }

  const input = pickPromptSurface();
  if (!input) return { ok: false, error: "prompt_input_not_found" };

  const before = new Set(collectMainImageSrcs());

  try {
    input.click();
  } catch {
    /* ignore */
  }

  if (input instanceof HTMLTextAreaElement) {
    input.focus();
    input.value = "";
    input.value = promptToSend;
    dispatchInputLike(input, promptToSend);
  } else {
    input.focus();
    try {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, promptToSend);
    } catch {
      input.textContent = promptToSend;
    }
    dispatchInputLike(input, promptToSend);
  }

  await clickSendOrEnter(input);

  const deadline = Date.now() + 180_000;
  let lastNew: string[] = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const all = collectMainImageSrcs();
    const fresh = all.filter((s) => !before.has(s));
    if (fresh.length >= 1) {
      lastNew = fresh;
      break;
    }
    lastNew = fresh;
  }

  if (lastNew.length < 1) {
    return { ok: false, error: "no_new_images", detail: `candidates=${lastNew.length}` };
  }

  const images: GeminiDomImage[] = [];
  for (const src of lastNew.slice(0, 8)) {
    const one = await srcToImagePayload(src);
    if (one) images.push(one);
  }
  if (!images.length) return { ok: false, error: "decode_images_failed" };
  return { ok: true, images };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (m.channel !== "GEMINI_IMAGE_BRIDGE" || m.action !== "RUN_TURN_DOM") return false;
  void runTurnDom((m.payload || {}) as RunPayload).then(sendResponse);
  return true;
});
