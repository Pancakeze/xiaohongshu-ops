import { Link } from 'react-router-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  apiGet,
  apiPatch,
  apiPost,
  type CopyVersion,
  type EntryDetail,
  type EntrySummary,
  type Template,
} from '../lib/api'
import { CopyCompetitorPanel } from '../components/CopyCompetitorPanel'
import { persistCurrentEntryId, resolveCurrentEntryId } from '../lib/currentEntry'

function emitEntryUpdated(entryId: string) {
  window.dispatchEvent(new CustomEvent('xhs:entry-updated', { detail: { entryId } }))
}

function sourceLabel(source: string): string {
  if (source === 'generated') return '新生成'
  return '人工'
}

function parseApiErr(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const m = e.message.match(/\{[\s\S]*"detail"\s*:\s*"([^"]+)"[\s\S]*\}\s*$/)
  if (m) return m[1]
  return e.message
}

export function CopyPage() {
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [entryId, setEntryId] = useState<string | null>(null)
  const [entries, setEntries] = useState<EntrySummary[]>([])
  const [entry, setEntry] = useState<EntryDetail | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [versions, setVersions] = useState<CopyVersion[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [benchmarkDraft, setBenchmarkDraft] = useState<{ title: string; body: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedVersionId

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2800)
  }, [])

  const sortedAsc = useMemo(
    () =>
      [...versions].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    [versions],
  )

  const vNumber = useCallback(
    (id: string) => {
      const i = sortedAsc.findIndex((v) => v.id === id)
      return i >= 0 ? i + 1 : 0
    },
    [sortedAsc],
  )

  const reloadAll = useCallback(async (id: string) => {
    const [d, vers, tpls] = await Promise.all([
      apiGet<EntryDetail>(`/api/entries/${id}`),
      apiGet<CopyVersion[]>(`/api/entries/${id}/copy-versions`),
      apiGet<Template[]>('/api/templates'),
    ])
    setEntry(d)
    setVersions(vers)
    setTemplates(tpls)
    return { entry: d, versions: vers }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoadErr(null)
        const list = await apiGet<EntrySummary[]>('/api/entries')
        if (cancelled) return
        setEntries(list)
        if (!list.length) {
          setLoadErr('暂无内容条目')
          return
        }
        const resolved = await resolveCurrentEntryId()
        const id =
          resolved && list.some((e) => e.id === resolved) ? resolved : list[0].id
        setEntryId(id)
        await reloadAll(id)
      } catch (e) {
        if (!cancelled) setLoadErr(parseApiErr(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadAll])

  useEffect(() => {
    if (entryId) persistCurrentEntryId(entryId)
  }, [entryId])

  useEffect(() => {
    setBenchmarkDraft(null)
  }, [entryId])

  useEffect(() => {
    if (!entryId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const on = (ev: Event) => {
      const e = ev as CustomEvent<{ entryId?: string }>
      if (e.detail?.entryId && e.detail.entryId !== entryId) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void (async () => {
          const { versions: vers } = await reloadAll(entryId)
          const sel = selectedRef.current
          const row = sel ? vers.find((v) => v.id === sel) : null
          if (row) {
            setTitle(row.title)
            setBody(row.body)
          }
        })()
      }, 600)
    }
    window.addEventListener('xhs:entry-updated', on)
    return () => {
      window.removeEventListener('xhs:entry-updated', on)
      if (timer) clearTimeout(timer)
    }
  }, [entryId, reloadAll])

  const primaryId = useMemo(
    () => versions.find((v) => v.is_primary)?.id ?? null,
    [versions],
  )

  useEffect(() => {
    if (!versions.length) {
      setSelectedVersionId(null)
      return
    }
    if (selectedVersionId && versions.some((v) => v.id === selectedVersionId)) return
    const pick = primaryId ?? versions[0].id
    setSelectedVersionId(pick)
    const row = versions.find((v) => v.id === pick)
    if (row) {
      setTitle(row.title)
      setBody(row.body)
    }
  }, [versions, selectedVersionId, primaryId])

  const selectVersion = useCallback(
    (id: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      const row = versions.find((v) => v.id === id)
      if (!row) return
      setSelectedVersionId(id)
      setTitle(row.title)
      setBody(row.body)
    },
    [versions],
  )

  useEffect(() => {
    if (!entryId || !selectedVersionId) return
    const row = versions.find((v) => v.id === selectedVersionId)
    if (!row) return
    if (row.title === title && row.body === body) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void (async () => {
        try {
          await apiPatch<CopyVersion>(`/api/entries/${entryId}/copy-versions/${selectedVersionId}`, {
            title,
            body,
          })
          const vers = await apiGet<CopyVersion[]>(`/api/entries/${entryId}/copy-versions`)
          setVersions(vers)
          if (row.is_primary) emitEntryUpdated(entryId)
        } catch (e) {
          showToast(parseApiErr(e))
        }
      })()
    }, 800)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [title, body, entryId, selectedVersionId, versions, showToast])

  const selectedRow = versions.find((v) => v.id === selectedVersionId)
  const templateName = useMemo(() => {
    const tid = entry?.selected_template_id
    if (!tid) return '（未选择模版）'
    const t = templates.find((x) => x.id === tid)
    return t?.name ?? '（模版已删除或未同步）'
  }, [entry, templates])

  const competitorPasteForGenerate = useMemo(() => {
    if (!benchmarkDraft) return null
    const t = benchmarkDraft.title.trim()
    const b = benchmarkDraft.body.trim()
    if (!t && !b) return null
    const parts: string[] = []
    if (t) parts.push(`【对标草稿标题】\n${t}`)
    if (b) parts.push(`【对标草稿正文】\n${b}`)
    const s = parts.join('\n\n')
    return s.length > 12000 ? s.slice(0, 12000) : s
  }, [benchmarkDraft])

  const onGenerate = async () => {
    if (!entryId) return
    setGenerating(true)
    try {
      await apiPost<CopyVersion>(`/api/entries/${entryId}/copy-versions/generate`, {
        competitor_url: null,
        competitor_paste: competitorPasteForGenerate,
      })
      const { versions: vers } = await reloadAll(entryId)
      const newest = vers[0]
      if (newest) {
        setSelectedVersionId(newest.id)
        setTitle(newest.title)
        setBody(newest.body)
      }
      emitEntryUpdated(entryId)
      showToast('已生成新文案版本并设为主版本，工作台标题与正文已同步。')
    } catch (e) {
      const d = parseApiErr(e)
      if (d === 'no_template_selected')
        showToast('请先在侧栏「选择模版」绑定到当前条目，或去模版管理启用模版。')
      else if (d === 'template_disabled') showToast('当前所选模版已停用，请在模版管理中启用或更换模版。')
      else if (d === 'ollama_unreachable')
        showToast('文案服务不可用：请确认本机已启动 Ollama，并已拉取模型（如 ollama pull qwen2.5-coder:14b）。')
      else if (d === 'ollama_bad_response') showToast('模型返回格式异常，请重试或检查 Ollama 日志。')
      else showToast(d)
    } finally {
      setGenerating(false)
    }
  }

  const onMakePrimary = async () => {
    if (!entryId || !selectedVersionId || !selectedRow || selectedRow.is_primary) return
    setPromoting(true)
    try {
      await apiPost<CopyVersion>(
        `/api/entries/${entryId}/copy-versions/${selectedVersionId}/make-primary`,
        {},
      )
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
      showToast('已设为主版本，工作台标题与正文已同步。')
    } catch (e) {
      showToast(parseApiErr(e))
    } finally {
      setPromoting(false)
    }
  }

  if (loadErr) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-rose-100 bg-white p-6 text-slate-800 shadow-sm">
        <p className="font-medium text-rose-700">加载失败</p>
        <p className="mt-2 text-sm text-slate-600">{loadErr}</p>
      </div>
    )
  }

  if (!entryId || !entry) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-slate-500">加载文案页…</div>
    )
  }

  return (
    <div className="relative mx-auto max-w-5xl text-slate-900" data-feature="copy">
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      {entries.length > 1 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label className="text-xs text-slate-500">当前条目</label>
          <select
            className="max-w-md rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
            value={entryId}
            onChange={(e) => {
              const id = e.target.value
              setEntryId(id)
              void (async () => {
                const { versions: vers } = await reloadAll(id)
                const p = vers.find((v) => v.is_primary)?.id ?? vers[0]?.id
                const row = p ? vers.find((v) => v.id === p) : undefined
                if (row) {
                  setSelectedVersionId(row.id)
                  setTitle(row.title)
                  setBody(row.body)
                }
              })()
            }}
          >
            {entries.map((e) => (
              <option key={e.id} value={e.id}>
                {(e.title || '（无标题）').slice(0, 48)}
                {e.title && e.title.length > 48 ? '…' : ''}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="mb-6">
        <CopyCompetitorPanel entryId={entryId} onBenchmarkDraftChange={setBenchmarkDraft} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-1">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">当前模版</div>
            <div className="mt-1 font-medium text-slate-900">{templateName}</div>
            <p className="mt-2 text-xs text-slate-500">
              「重新生成」始终按此处绑定模版（名称、场景、段落结构及模版元数据）调用模型；在「模版管理」可编辑模版，侧栏「选择模版」可切换绑定。
            </p>
          </div>
          <div className="rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-white">
            <strong className="text-slate-200">新生成文案在哪里？</strong>
            <br />
            每次「重新生成」会新增一条<strong>文案版本</strong>（左侧列表）。主文案与「
            <strong>工作台与发布</strong>」编辑区同源；图片页据主文案生图入图稿池；笔记管理可组合草稿。
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 text-xs font-medium text-slate-500">文案版本（条目内）</div>
            <ul className="space-y-1 text-sm">
              {versions.map((v) => {
                const active = v.id === selectedVersionId
                const t = new Date(v.created_at)
                const hm = t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => selectVersion(v.id)}
                      className={`w-full rounded-lg px-2 py-1.5 text-left ${
                        active
                          ? 'bg-slate-100 font-medium text-slate-900'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      v{vNumber(v.id)} · {sourceLabel(v.source)} · {hm}
                      {v.is_primary ? (
                        <span className="ml-1 text-[10px] text-emerald-600">主</span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
            {selectedRow && !selectedRow.is_primary ? (
              <button
                type="button"
                disabled={promoting}
                className="mt-3 w-full rounded-lg border border-brand/40 bg-brand-soft py-2 text-xs font-medium text-brand hover:bg-rose-100 disabled:opacity-50"
                onClick={() => void onMakePrimary()}
              >
                {promoting ? '处理中…' : '设为主版本（同步工作台）'}
              </button>
            ) : null}
          </div>
          <div className="rounded-xl border border-red-100 bg-[var(--color-brand-soft)] p-4 text-sm text-slate-700">
            <strong className="text-brand">真人感</strong>：口语化断句、避免「综上所述」等套话；禁用夸张保过承诺。
          </div>
        </div>

        <div className="flex min-h-[320px] flex-col rounded-xl border border-slate-200 bg-white p-5 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-900">标题与正文</h2>
            <div className="flex flex-col items-end gap-1">
              <button
                type="button"
                disabled={generating}
                className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
                onClick={() => void onGenerate()}
              >
                {generating ? '生成中…' : '重新生成'}
              </button>
              <span className="max-w-xs text-right text-[10px] text-slate-600">
                按当前模版「{templateName}」的结构与场景生成
              </span>
              {competitorPasteForGenerate ? (
                <span className="max-w-xs text-right text-[10px] text-emerald-700">
                  并带上竞品「对标草稿」作参考
                </span>
              ) : (
                <span className="max-w-xs text-right text-[10px] text-slate-400">未带对标草稿</span>
              )}
            </div>
          </div>
          <label className="mb-1 block text-xs text-slate-500">标题</label>
          <input
            type="text"
            className="mb-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={500}
          />
          <label className="mb-1 block text-xs text-slate-500">正文</label>
          <textarea
            rows={12}
            className="min-h-[12rem] w-full flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm leading-relaxed"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <p className="mt-2 text-xs text-slate-400">
            <Link to="/workbench" className="font-medium text-brand hover:underline">
              去工作台与发布
            </Link>
            查看手机预览、图稿条与发布流程（主版本与上文同源）。
          </p>
        </div>
      </div>
    </div>
  )
}
