import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  apiCreateGoogleImageSession,
  apiGetGoogleImageSession,
  type GoogleImageSession,
  type GoogleImageTurn,
} from '../lib/api'
import { resolveCurrentEntryId } from '../lib/currentEntry'
import { tryGeminiExtensionRun } from '../lib/geminiExtensionBridge'
import { getBridgeExtensionId, persistBridgeExtensionId } from '../lib/publishBridge'

type LocalSessionRef = { id: string; createdAt: string; label?: string }

const LS_KEY = 'xhs:google_image_sessions:v1'
const LS_LAST = 'xhs:google_image_sessions:last'

function parseApiErr(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const raw = e.message
  if (raw.includes('draft_image_pool_full')) return '图稿池已满（可在服务端环境变量调整上限）'
  const m = raw.match(/\{[\s\S]*"detail"\s*:\s*"([^"]+)"[\s\S]*\}\s*$/)
  if (m) return m[1]
  return raw
}

function safeJsonParse(s: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function loadLocalSessions(): LocalSessionRef[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    const out: LocalSessionRef[] = []
    for (const x of v) {
      if (!x || typeof x !== 'object') continue
      const r = x as Record<string, unknown>
      if (typeof r.id !== 'string' || !r.id) continue
      const createdAt = typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString()
      const label = typeof r.label === 'string' ? r.label : undefined
      out.push({ id: r.id, createdAt, label })
    }
    return out
  } catch {
    return []
  }
}

function persistLocalSessions(list: LocalSessionRef[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 50)))
  } catch {
    /* ignore */
  }
}

function persistLastSessionId(id: string | null) {
  try {
    if (!id) localStorage.removeItem(LS_LAST)
    else localStorage.setItem(LS_LAST, id)
  } catch {
    /* ignore */
  }
}

function loadLastSessionId(): string | null {
  try {
    const v = localStorage.getItem(LS_LAST)
    return v && v.trim() ? v : null
  } catch {
    return null
  }
}

function labelForSession(s: LocalSessionRef): string {
  const dt = new Date(s.createdAt)
  const hint = isNaN(dt.getTime()) ? '' : dt.toLocaleString()
  const short = s.id.replace(/-/g, '').slice(0, 8)
  return s.label?.trim() ? `${s.label.trim()} · ${short}` : hint ? `${hint} · ${short}` : short
}

function turnTitle(turn: GoogleImageTurn, idx: number): string {
  const dt = new Date(turn.created_at)
  const t = isNaN(dt.getTime()) ? '' : dt.toLocaleTimeString()
  return `第 ${idx + 1} 轮${t ? ` · ${t}` : ''}`
}

function assetsCount(turn: GoogleImageTurn): number {
  return (turn.assets || []).filter((a) => a.public_url).length
}

export function GoogleImagesPage() {
  const [sessions, setSessions] = useState<LocalSessionRef[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [session, setSession] = useState<GoogleImageSession | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busyCreate, setBusyCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [paramsText, setParamsText] = useState('{\n  "size": "1024x1024"\n}')
  const [selectedAssetUrl, setSelectedAssetUrl] = useState<string | null>(null)
  const [lastSubmitted, setLastSubmitted] = useState<{ prompt: string; params: Record<string, unknown> } | null>(null)
  const [extIdInput, setExtIdInput] = useState(() => getBridgeExtensionId(''))
  const [writeToDraftPool, setWriteToDraftPool] = useState(false)
  const [entryIdForPool, setEntryIdForPool] = useState<string | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2800)
  }, [])

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [sessions])

  const sortedTurns = useMemo(() => {
    const turns = session?.turns ?? []
    return [...turns].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  }, [session])

  const reloadSession = useCallback(async (id: string) => {
    const s = await apiGetGoogleImageSession(id)
    setSession(s)
    const newestAsset =
      [...(s.turns || [])]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .flatMap((t) => (t.assets || []).filter((a) => a.public_url).map((a) => a.public_url as string))
        .find(Boolean) ?? null
    setSelectedAssetUrl((cur) => cur ?? newestAsset)
    return s
  }, [])

  useEffect(() => {
    const list = loadLocalSessions()
    setSessions(list)
    const last = loadLastSessionId()
    const pick = last && list.some((s) => s.id === last) ? last : list[0]?.id ?? null
    setSessionId(pick)
  }, [])

  useEffect(() => {
    void resolveCurrentEntryId().then(setEntryIdForPool)
  }, [])

  useEffect(() => {
    if (!sessionId) {
      setSession(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        setLoadErr(null)
        persistLastSessionId(sessionId)
        await reloadSession(sessionId)
      } catch (e) {
        if (!cancelled) {
          setLoadErr(parseApiErr(e))
          setSession(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadSession, sessionId])

  const createSession = async () => {
    setBusyCreate(true)
    try {
      const out = await apiCreateGoogleImageSession()
      const ref: LocalSessionRef = { id: out.id, createdAt: new Date().toISOString() }
      const next = [ref, ...sessions.filter((s) => s.id !== out.id)]
      setSessions(next)
      persistLocalSessions(next)
      setSessionId(out.id)
      showToast('已创建新会话')
    } catch (e) {
      showToast(parseApiErr(e))
    } finally {
      setBusyCreate(false)
    }
  }

  const submitViaExtension = async (override?: { prompt?: string; params?: Record<string, unknown> }) => {
    if (!sessionId) {
      showToast('请先创建或选择一个会话')
      return
    }
    const p = (override?.prompt ?? prompt).trim()
    if (!p) {
      showToast('请输入生成指令')
      return
    }

    let params: Record<string, unknown> = override?.params ?? {}
    if (!override?.params) {
      const parsed = safeJsonParse(paramsText.trim() || '{}')
      if (!parsed.ok) {
        showToast(`参数 JSON 不合法：${parsed.error}`)
        return
      }
      if (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
        params = parsed.value as Record<string, unknown>
      } else {
        showToast('参数必须是 JSON 对象，例如 {"size":"1024x1024"}')
        return
      }
    }

    if (writeToDraftPool && !entryIdForPool) {
      showToast('已勾选入图稿池，但未解析到当前条目：请先到「图片生成与管理」或工作台选中条目')
      return
    }

    setBusy(true)
    setLoadErr(null)
    setLastSubmitted({ prompt: p, params })
    tryGeminiExtensionRun(
      extIdInput,
      {
        prompt: p,
        sessionId,
        params,
        writeToDraftPool: writeToDraftPool && !!entryIdForPool,
        entryId: entryIdForPool,
      },
      async (r) => {
        setBusy(false)
        if (!r.ok) {
          const msg = r.detail ? `${r.error} — ${r.detail}` : r.error
          setLoadErr(msg)
          showToast(msg)
          if (sessionId) await reloadSession(sessionId).catch(() => {})
          return
        }
        showToast('扩展生图已完成')
        setPrompt('')
        if (sessionId) await reloadSession(sessionId)
      },
    )
  }

  const retryLast = () => {
    if (!lastSubmitted) {
      showToast('暂无可重试的请求')
      return
    }
    void submitViaExtension({ prompt: lastSubmitted.prompt, params: lastSubmitted.params })
  }

  const pinSessionLabel = (text: string) => {
    if (!sessionId) return
    const next = sessions.map((s) => (s.id === sessionId ? { ...s, label: text } : s))
    setSessions(next)
    persistLocalSessions(next)
  }

  if (loadErr && !session) {
    return (
      <div className="mx-auto max-w-4xl rounded-xl border border-red-100 bg-white p-8 text-slate-800 shadow-sm">
        <p className="font-medium text-red-600">加载失败</p>
        <p className="mt-2 text-sm text-slate-600">{loadErr}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            onClick={() => sessionId && void reloadSession(sessionId)}
          >
            重试加载
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => void createSession()}
          >
            新建会话
          </button>
          <Link to="/images" className="self-center text-sm font-medium text-brand hover:underline">
            去「图片生成与管理」
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="relative mx-auto max-w-6xl text-slate-900">
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      <div className="mb-4 max-w-4xl rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-white">
        <strong className="text-slate-200">Google 生图（聊天式）</strong>
        <br />
        推荐：<strong className="text-slate-100">用扩展</strong>
        在<strong className="text-slate-100">你已正常登录</strong>的 Chrome 里打开 Gemini 页填 prompt、抓图并回传（与「小红书发布桥接」同一扩展，需填写扩展
        ID）。
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Link to="/images" className="text-xs font-medium text-brand hover:underline">
          去「图片生成与管理」
        </Link>
        <Link to="/workbench" className="text-xs font-medium text-brand hover:underline">
          去工作台与发布
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">会话</h3>
            <button
              type="button"
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-50"
              disabled={busyCreate}
              onClick={() => void createSession()}
            >
              {busyCreate ? '创建中…' : '新建'}
            </button>
          </div>

          <label className="block text-xs text-slate-500">
            当前会话
            <select
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
              value={sessionId ?? ''}
              onChange={(e) => setSessionId(e.target.value || null)}
            >
              <option value="">— 请选择或新建 —</option>
              {sortedSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {labelForSession(s)}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs text-slate-500">
            会话备注（本地保存）
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              placeholder="例如：数学提分 · 粉彩卡片"
              value={sessions.find((s) => s.id === sessionId)?.label ?? ''}
              onChange={(e) => pinSessionLabel(e.target.value)}
              disabled={!sessionId}
            />
          </label>

          {session ? (
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                  {session.id.slice(0, 8)}…
                </span>
                <span className="text-slate-500">状态：</span>
                <span className={session.status === 'error' ? 'font-medium text-red-600' : 'font-medium text-slate-700'}>
                  {session.status}
                </span>
              </div>
              {session.last_error ? (
                <p className="mt-2 text-[11px] leading-relaxed text-red-700">{session.last_error}</p>
              ) : (
                <p className="mt-2 text-[11px] text-slate-400">
                  提示：请先在 Chrome 中登录 Gemini；本页仅通过扩展在已打开的标签页内操作。
                </p>
              )}
              <button
                type="button"
                className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => sessionId && void reloadSession(sessionId).catch((e) => showToast(parseApiErr(e)))}
                disabled={!sessionId}
              >
                刷新会话
              </button>
            </div>
          ) : (
            <p className="text-xs text-slate-400">暂无会话数据。</p>
          )}
        </aside>

        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-slate-900">发起生成</h2>
                <p className="mt-1 text-xs text-slate-500">每次提交会创建一轮 turn；生成成功后会回写图片列表。</p>
              </div>
              <button
                type="button"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                onClick={retryLast}
                disabled={!sessionId || busy || !lastSubmitted}
              >
                重试上次
              </button>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-[1fr_280px]">
              <div>
                <label className="block text-xs text-slate-500">指令（Prompt）</label>
                <textarea
                  rows={5}
                  className="mt-1 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm leading-relaxed"
                  placeholder="例如：生成一张 1:1 的粉彩风数学提分卡片，包含标题与 3 个要点。"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  disabled={!sessionId || busy}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!sessionId || busy || !prompt.trim()}
                    onClick={() => void submitViaExtension()}
                  >
                    {busy ? '执行中…' : '发送（扩展）'}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    disabled={!sessionId || busy || sortedTurns.length === 0}
                    onClick={() => {
                      const last = sortedTurns[sortedTurns.length - 1]
                      if (last?.prompt) setPrompt(last.prompt)
                    }}
                  >
                    继续优化（带入上一轮）
                  </button>
                </div>
                {loadErr ? <p className="mt-2 text-xs text-red-600">{loadErr}</p> : null}
              </div>

              <div>
                <label className="block text-xs text-slate-500">参数（JSON 对象，可选）</label>
                <textarea
                  rows={5}
                  className="mt-1 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[12px] leading-relaxed text-slate-800"
                  value={paramsText}
                  onChange={(e) => setParamsText(e.target.value)}
                  disabled={!sessionId || busy}
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  会随指令一并交给 Gemini；敏感字段不会写入 turn.params。
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/80 p-4">
              <p className="text-xs font-medium text-slate-800">扩展与图稿池</p>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={writeToDraftPool}
                  onChange={(e) => setWriteToDraftPool(e.target.checked)}
                  disabled={busy}
                />
                生成成功后写入当前条目的图稿池（与「图片生成与管理」同源）
              </label>
              <p className="mt-1 text-[11px] text-slate-500">
                当前条目：
                <span className="font-mono text-slate-700">{entryIdForPool ?? '（未设置，请从图片页或工作台进入以绑定 sessionStorage）'}</span>
              </p>
              <label className="mt-3 block text-xs text-slate-500">
                扩展 ID（与小红书发布桥接相同，chrome://extensions）
                <input
                  type="text"
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-800"
                  placeholder="例如：abcdefghijklmnopqrstuvwxyz123456"
                  value={extIdInput}
                  onChange={(e) => setExtIdInput(e.target.value)}
                  onBlur={() => persistBridgeExtensionId(extIdInput)}
                  disabled={busy}
                />
              </label>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">历史 turns</h3>
                <span className="text-xs text-slate-500">{sortedTurns.length} 轮</span>
              </div>

              <ul className="mt-3 max-h-[min(70vh,820px)] space-y-3 overflow-y-auto pr-1">
                {sortedTurns.map((t, idx) => {
                  const n = assetsCount(t)
                  const ok = !t.last_error && n > 0
                  return (
                    <li key={t.id} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-semibold text-slate-800">{turnTitle(t, idx)}</span>
                          <span
                            className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                              ok ? 'bg-emerald-100 text-emerald-900' : t.last_error ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-700'
                            }`}
                          >
                            {ok ? `成功 · ${n} 张` : t.last_error ? '失败' : '处理中/无图'}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          disabled={!sessionId || busy}
                          onClick={() =>
                            void submitViaExtension({
                              prompt: t.prompt,
                              params: (t.params || {}) as Record<string, unknown>,
                            })
                          }
                        >
                          重试本轮
                        </button>
                      </div>

                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{t.prompt}</p>

                      {t.last_error ? (
                        <p className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-red-100 bg-white px-3 py-2 text-xs text-red-700">
                          {t.last_error}
                        </p>
                      ) : null}

                      {t.assets?.length ? (
                        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                          {t.assets
                            .filter((a) => a.public_url)
                            .map((a) => (
                              <button
                                key={a.id}
                                type="button"
                                className={`relative aspect-square overflow-hidden rounded-lg border ${
                                  selectedAssetUrl === a.public_url ? 'border-brand ring-1 ring-brand/30' : 'border-slate-200'
                                } bg-white`}
                                onClick={() => setSelectedAssetUrl(a.public_url ?? null)}
                              >
                                <img src={a.public_url ?? ''} alt="" className="h-full w-full object-cover" />
                                {(a.width || a.height) && (
                                  <span className="absolute bottom-1 left-1 rounded bg-slate-900/70 px-1.5 py-0.5 text-[10px] text-white">
                                    {a.width ?? '?'}×{a.height ?? '?'}
                                  </span>
                                )}
                              </button>
                            ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-slate-400">本轮暂无图片产物。</p>
                      )}
                    </li>
                  )
                })}
              </ul>

              {sortedTurns.length === 0 ? (
                <p className="mt-3 text-xs text-slate-400">暂无历史。创建会话后在上方输入 prompt 并点击「发送（扩展）」。</p>
              ) : null}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-slate-900">图片预览</h3>
              <p className="mt-1 text-xs text-slate-500">点击左侧缩略图切换预览。</p>
              <div className="mt-3 aspect-square overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br from-rose-100 via-white to-sky-100">
                {selectedAssetUrl ? (
                  <img src={selectedAssetUrl} alt="" className="h-full w-full object-contain bg-slate-900/5" />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-slate-400">暂无图片</div>
                )}
              </div>
              {selectedAssetUrl ? (
                <div className="mt-3">
                  <a
                    href={selectedAssetUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    新标签打开原图
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

