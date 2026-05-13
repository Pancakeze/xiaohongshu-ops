/** 与扩展 `extensions/xhs-publish-bridge` 及原型协议一致 */

/** 与扩展默认一致：必须 `target=image` 才进入图文编辑页（非「上传视频」首屏） */
export const XHS_WEB_PUBLISH_URL =
  'https://creator.xiaohongshu.com/publish/publish?source=official&target=image'

export const XHS_BRIDGE_EXT_STORAGE_KEY = 'xhs_publish_bridge_ext_id'

export function getBridgeExtensionId(inputValue: string): string {
  const fromInput = inputValue.trim()
  if (fromInput) return fromInput
  try {
    return (localStorage.getItem(XHS_BRIDGE_EXT_STORAGE_KEY) || '').trim()
  } catch {
    return ''
  }
}

export function persistBridgeExtensionId(value: string): void {
  try {
    localStorage.setItem(XHS_BRIDGE_EXT_STORAGE_KEY, value.trim())
  } catch {
    /* ignore */
  }
}

/** 去重、去首尾 #、限长（与 API 校验大致一致） */
export function normalizeTopicList(raw: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    let s = String(r ?? '')
      .trim()
      .replace(/^#+/u, '')
      .trim()
    if (!s || s.includes('\n') || s.includes('\r')) continue
    if (s.length > 80) s = s.slice(0, 80)
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= 35) break
  }
  return out
}

/** 多行/逗号分隔的话题输入 → 列表 */
export function parseTopicsInput(text: string): string[] {
  return normalizeTopicList(text.split(/[\n,，、]+/u).map((x) => x.trim()))
}

export function topicsListsEqual(a: string[], b: string[]): boolean {
  const x = normalizeTopicList(a)
  const y = normalizeTopicList(b)
  if (x.length !== y.length) return false
  return x.every((v, i) => v === y[i])
}

/** 发布到小红书正文：在正文后追加 #话题（与创作页「正文里带 #」一致） */
export function formatBodyForXhsPublish(body: string, topics: string[]): string {
  const tags = normalizeTopicList(topics)
  if (!tags.length) return body
  const suffix = tags.map((t) => `#${t}`).join(' ')
  const b = body.replace(/\s+$/u, '')
  return b ? `${b}\n\n${suffix}` : suffix
}

export function buildPublishClipboardPayload(
  title: string,
  body: string,
  publishImages: { label: string; star: boolean }[],
  topics?: string[],
): string {
  const bodyWithTags = formatBodyForXhsPublish(body, topics ?? [])
  let imgLine: string
  if (publishImages.length) {
    imgLine =
      '\n\n———\n【配图清单·参与发布】' +
      publishImages.length +
      ' 张：' +
      publishImages
        .map((im, i) => `${i + 1}.${im.label}${im.star ? '（封面）' : ''}`)
        .join('；') +
      '\n（请到创作页相册按顺序上传对应图片文件）'
  } else {
    imgLine = '\n\n———\n【配图】当前无参与发布图稿，请在创作页相册上传。'
  }
  return (
    title +
    (title && bodyWithTags ? '\n\n' : '') +
    bodyWithTags +
    imgLine
  )
}

export type ExtensionPublishResult =
  | { ok: true; response: unknown }
  | { ok: false; reason: string; response?: unknown }

/** 写入 PublishAttempt.bridge_payload：不含标题/正文全文，仅扩展回包摘要 */
export function summarizeBridgeResponseForLog(response: unknown): Record<string, unknown> | undefined {
  if (!response || typeof response !== 'object') return undefined
  const r = response as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof r.tabId === 'number') out.tabId = r.tabId
  const inner = r.result
  if (inner && typeof inner === 'object') {
    const fr = inner as Record<string, unknown>
    const filled = fr.filled
    out.fill = {
      ok: Boolean(fr.ok),
      detail: typeof fr.detail === 'string' ? fr.detail.slice(0, 500) : undefined,
      filled: filled && typeof filled === 'object' ? filled : undefined,
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** 外连扩展心跳：与 `extensions/xhs-publish-bridge` 的 `PING` 一致 */
export function tryPingBridgeExtension(
  extId: string,
  onDone: (r: { ok: true; version: string } | { ok: false; reason: string }) => void,
): void {
  if (!extId) {
    onDone({ ok: false, reason: 'no_extension_id' })
    return
  }
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    onDone({ ok: false, reason: 'no_chrome_runtime（请用 Chrome 打开运营台）' })
    return
  }
  const msg = { channel: 'XHS_PUBLISH_BRIDGE' as const, version: 1 as const, action: 'PING' as const }
  try {
    chrome.runtime.sendMessage(extId, msg, (response: unknown) => {
      const errMsg = chrome.runtime.lastError?.message
      if (errMsg) {
        onDone({ ok: false, reason: errMsg })
        return
      }
      const resp = response as { ok?: boolean; version?: string } | null
      if (resp?.ok && typeof resp.version === 'string') {
        onDone({ ok: true, version: resp.version })
        return
      }
      onDone({ ok: false, reason: '扩展未返回版本（请确认已加载桥接扩展）' })
    })
  } catch (e) {
    onDone({ ok: false, reason: String(e) })
  }
}

function isAllowedPublishImageUrl(u: string): boolean {
  const t = u.trim()
  return (
    t.startsWith('https://') ||
    t.startsWith('http://127.0.0.1') ||
    t.startsWith('http://localhost')
  )
}

/** 传给扩展的可选参数（与 `extensions/xhs-publish-bridge` types 一致） */
export type ExtensionPublishOptions = {
  /** 首张参与发布图 URL，用于创作平台必须先有图才出现标题/正文 */
  firstImageUrl?: string
  /** 全部参与发布图 URL（封面优先），扩展会尝试多图写入相册 */
  imageUrls?: string[]
}

export function tryExtensionPublish(
  extId: string,
  title: string,
  body: string,
  onDone: (r: ExtensionPublishResult) => void,
  options?: ExtensionPublishOptions,
): void {
  if (!extId) {
    onDone({ ok: false, reason: 'no_extension_id', response: null })
    return
  }
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    onDone({ ok: false, reason: 'no_chrome_runtime', response: null })
    return
  }
  const payload: { title: string; body: string; firstImageUrl?: string; imageUrls?: string[] } = {
    title,
    body,
  }
  const u = options?.firstImageUrl?.trim()
  if (u && isAllowedPublishImageUrl(u)) {
    payload.firstImageUrl = u
  }
  const imgs = options?.imageUrls?.map((x) => x.trim()).filter((x) => x && isAllowedPublishImageUrl(x))
  if (imgs?.length) {
    payload.imageUrls = imgs
  }

  const msg = {
    channel: 'XHS_PUBLISH_BRIDGE',
    version: 1,
    action: 'FILL_IMG_NOTE',
    payload,
  }
  try {
    chrome.runtime.sendMessage(extId, msg, (response: unknown) => {
      const errMsg = chrome.runtime.lastError?.message
      if (errMsg) {
        onDone({ ok: false, reason: errMsg, response: null })
        return
      }
      const resp =
        (response && typeof response === 'object' ? (response as Record<string, unknown>) : null) || null
      if (resp && resp.ok) {
        onDone({ ok: true, response })
        return
      }
      // 扩展通常返回 { ok:false, error?: string }；但 fillOnTab 失败时会回 { ok:false, result:{ detail } }
      const maybeResult = resp?.result
      const nestedDetail =
        maybeResult && typeof maybeResult === 'object' && typeof (maybeResult as any).detail === 'string'
          ? String((maybeResult as any).detail)
          : undefined
      onDone({
        ok: false,
        reason:
          (resp && (typeof resp.error === 'string' ? resp.error : undefined)) ||
          (resp && (typeof resp.detail === 'string' ? resp.detail : undefined)) ||
          nestedDetail ||
          'extension_failed',
        response,
      })
    })
  } catch (e) {
    onDone({ ok: false, reason: String(e), response: null })
  }
}

export type ExtensionScrapeTopNotesResult =
  | { ok: true; keyword: string; items: { url: string; title: string; author?: string; excerpt?: string; like_text?: string }[] }
  | { ok: false; reason: string; detail?: string }

export function tryExtensionScrapeTopNotes(
  extId: string,
  keyword: string,
  onDone: (r: ExtensionScrapeTopNotesResult) => void,
  opts?: { limit?: number },
): void {
  const kw = keyword.trim()
  if (!extId) {
    onDone({ ok: false, reason: 'no_extension_id' })
    return
  }
  if (!kw) {
    onDone({ ok: false, reason: 'missing_keyword' })
    return
  }
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    onDone({ ok: false, reason: 'no_chrome_runtime（请用 Chrome 打开运营台）' })
    return
  }
  const msg = {
    channel: 'XHS_PUBLISH_BRIDGE' as const,
    version: 1 as const,
    action: 'SCRAPE_TOP_NOTES' as const,
    payload: { keyword: kw, limit: opts?.limit ?? 10 },
  }
  try {
    chrome.runtime.sendMessage(extId, msg, (response: unknown) => {
      const errMsg = chrome.runtime.lastError?.message
      if (errMsg) {
        onDone({ ok: false, reason: errMsg })
        return
      }
      const resp = (response && typeof response === 'object' ? (response as Record<string, unknown>) : null) || null
      if (resp && resp.ok) {
        onDone({
          ok: true,
          keyword: typeof resp.keyword === 'string' ? resp.keyword : kw,
          items: Array.isArray(resp.items) ? (resp.items as any[]) : [],
        })
        return
      }
      onDone({
        ok: false,
        reason: typeof resp?.error === 'string' ? String(resp.error) : 'scrape_failed',
        detail: typeof resp?.detail === 'string' ? String(resp.detail) : undefined,
      })
    })
  } catch (e) {
    onDone({ ok: false, reason: String(e) })
  }
}

export function tryExtensionScrapeProfileNotes(
  extId: string,
  profileUrl: string,
  onDone: (r: ExtensionScrapeTopNotesResult) => void,
  opts?: { limit?: number },
): void {
  const u = profileUrl.trim()
  if (!extId) {
    onDone({ ok: false, reason: 'no_extension_id' })
    return
  }
  if (!u) {
    onDone({ ok: false, reason: 'missing_profile_url' })
    return
  }
  if (!u.startsWith('https://www.xiaohongshu.com/user/profile/')) {
    onDone({ ok: false, reason: 'bad_profile_url（请粘贴形如 https://www.xiaohongshu.com/user/profile/... ）' })
    return
  }
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    onDone({ ok: false, reason: 'no_chrome_runtime（请用 Chrome 打开运营台）' })
    return
  }
  const msg = {
    channel: 'XHS_PUBLISH_BRIDGE' as const,
    version: 1 as const,
    action: 'SCRAPE_PROFILE_NOTES' as const,
    payload: { profileUrl: u, limit: opts?.limit ?? 10 },
  }
  try {
    chrome.runtime.sendMessage(extId, msg, (response: unknown) => {
      const errMsg = chrome.runtime.lastError?.message
      if (errMsg) {
        onDone({ ok: false, reason: errMsg })
        return
      }
      const resp = (response && typeof response === 'object' ? (response as Record<string, unknown>) : null) || null
      if (resp && resp.ok) {
        onDone({
          ok: true,
          keyword: typeof resp.keyword === 'string' ? resp.keyword : u,
          items: Array.isArray(resp.items) ? (resp.items as any[]) : [],
        })
        return
      }
      onDone({
        ok: false,
        reason: typeof resp?.error === 'string' ? String(resp.error) : 'scrape_failed',
        detail: typeof resp?.detail === 'string' ? String(resp.detail) : undefined,
      })
    })
  } catch (e) {
    onDone({ ok: false, reason: String(e) })
  }
}

export function tryExtensionScrapeExploreRelated(
  extId: string,
  noteUrl: string,
  onDone: (r: ExtensionScrapeTopNotesResult) => void,
  opts?: { limit?: number },
): void {
  const u = noteUrl.trim()
  if (!extId) {
    onDone({ ok: false, reason: 'no_extension_id' })
    return
  }
  if (!u) {
    onDone({ ok: false, reason: 'missing_note_url' })
    return
  }
  if (!u.startsWith('https://www.xiaohongshu.com/explore/')) {
    onDone({ ok: false, reason: 'bad_note_url（请粘贴形如 https://www.xiaohongshu.com/explore/... ）' })
    return
  }
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    onDone({ ok: false, reason: 'no_chrome_runtime（请用 Chrome 打开运营台）' })
    return
  }
  const msg = {
    channel: 'XHS_PUBLISH_BRIDGE' as const,
    version: 1 as const,
    action: 'SCRAPE_NOTE_RELATED' as const,
    payload: { noteUrl: u, limit: opts?.limit ?? 10 },
  }
  try {
    chrome.runtime.sendMessage(extId, msg, (response: unknown) => {
      const errMsg = chrome.runtime.lastError?.message
      if (errMsg) {
        onDone({ ok: false, reason: errMsg })
        return
      }
      const resp = (response && typeof response === 'object' ? (response as Record<string, unknown>) : null) || null
      if (resp && resp.ok) {
        onDone({
          ok: true,
          keyword: typeof resp.keyword === 'string' ? resp.keyword : u,
          items: Array.isArray(resp.items) ? (resp.items as any[]) : [],
        })
        return
      }
      onDone({
        ok: false,
        reason: typeof resp?.error === 'string' ? String(resp.error) : 'scrape_failed',
        detail: typeof resp?.detail === 'string' ? String(resp.detail) : undefined,
      })
    })
  } catch (e) {
    onDone({ ok: false, reason: String(e) })
  }
}

export function publishClipboardFallback(
  title: string,
  body: string,
  publishImages: { label: string; star: boolean }[],
  onToast: (msg: string) => void,
  topics?: string[],
): void {
  const clipPayload = buildPublishClipboardPayload(title, body, publishImages, topics)
  // 注意：本函数常在异步回调里触发（例如扩展失败后降级），可能不再处于“用户手势”上下文；
  // 某些浏览器此时会让 window.open 返回 null，且不同策略下仍可能实际打开了新标签。
  // 因此不要用 “win==null => 一定没打开” 来给用户报错。
  let win: Window | null = null
  try {
    win = window.open(XHS_WEB_PUBLISH_URL, '_blank', 'noopener,noreferrer')
  } catch {
    win = null
  }
  if (!win) {
    try {
      win = window.open(XHS_WEB_PUBLISH_URL, '_blank')
    } catch {
      win = null
    }
  }
  const afterOpen = (clipboardOk: boolean) => {
    let msg = '已打开或已尝试打开小红书发布页（降级：剪贴板）。'
    if (clipboardOk) msg += ' 标题、正文与配图清单已复制到剪贴板。'
    else msg += ' 剪贴板未授权时请手动复制标题与正文。'
    if (!win) msg += ` 若未弹出新标签，请点击：${XHS_WEB_PUBLISH_URL}`
    onToast(msg)
  }
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(clipPayload).then(
      () => afterOpen(true),
      () => afterOpen(false),
    )
  } else {
    afterOpen(false)
  }
}
