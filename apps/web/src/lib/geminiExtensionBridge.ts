import { getBridgeExtensionId } from './publishBridge'

const apiBase = () => (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export type GeminiExtensionRunResult =
  | { ok: true; turn: unknown }
  | { ok: false; error: string; detail?: string }

/**
 * 与 `extensions/xhs-publish-bridge` 共用扩展 ID：在已登录的 Gemini 标签页内填 prompt、抓图并 POST 到 API `turns/via-extension`。
 */
export function tryGeminiExtensionRun(
  extIdInput: string,
  payload: {
    prompt: string
    sessionId: string
    params?: Record<string, unknown>
  },
  onDone: (r: GeminiExtensionRunResult) => void,
): void {
  const extId = getBridgeExtensionId(extIdInput)
  if (!extId) {
    onDone({ ok: false, error: '请在工作台填写与发布相同的「发布助手编号」' })
    return
  }
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    onDone({ ok: false, error: '请使用 Chrome 打开本运营台，并安装发布助手扩展' })
    return
  }
  const token = import.meta.env.VITE_API_BEARER_TOKEN || ''
  const base = apiBase() || 'http://127.0.0.1:8000'
  const msg = {
    channel: 'GEMINI_IMAGE_BRIDGE' as const,
    version: 1 as const,
    action: 'GEMINI_RUN_TURN' as const,
    payload: {
      prompt: payload.prompt,
      sessionId: payload.sessionId,
      apiBaseUrl: base,
      bearerToken: token,
      writeToDraftPool: false,
      entryId: null,
      sourceCopyVersionId: null,
      params: payload.params ?? {},
    },
  }
  try {
    chrome.runtime.sendMessage(extId, msg, (response: unknown) => {
      const errMsg = chrome.runtime.lastError?.message
      if (errMsg) {
        onDone({ ok: false, error: errMsg })
        return
      }
      const r = response && typeof response === 'object' ? (response as Record<string, unknown>) : null
      if (r?.ok) {
        onDone({ ok: true, turn: r.turn })
        return
      }
      onDone({
        ok: false,
        error: typeof r?.error === 'string' ? r.error : '发布助手未返回有效结果',
        detail: typeof r?.detail === 'string' ? r.detail : undefined,
      })
    })
  } catch (e) {
    onDone({ ok: false, error: String(e) })
  }
}
