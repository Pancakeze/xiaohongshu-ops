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
import { appConfirm } from '../lib/appDialog'
import { persistCurrentEntryId, resolveCurrentEntryId } from '../lib/currentEntry'
import { formatYmdHm } from '../lib/formatDate'
import { XHS_K12_COMPLIANCE_ITEMS } from '../lib/xhsK12Compliance'

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
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const justSavedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedVersionId

  const selectedVersion = useMemo(
    () => (selectedVersionId ? versions.find((v) => v.id === selectedVersionId) ?? null : null),
    [versions, selectedVersionId],
  )

  const isDirty = useMemo(() => {
    if (!selectedVersion) return false
    return selectedVersion.title !== title || selectedVersion.body !== body
  }, [selectedVersion, title, body])

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
    const onTemplateSelected = (ev: Event) => {
      const d = (ev as CustomEvent<{ entryId?: string; templateId?: string }>).detail
      if (!d?.templateId || d.entryId !== entryId) return
      setEntry((prev) => (prev ? { ...prev, selected_template_id: d.templateId! } : prev))
    }
    window.addEventListener('xhs:template-selected', onTemplateSelected)
    return () => window.removeEventListener('xhs:template-selected', onTemplateSelected)
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
    async (id: string) => {
      if (id === selectedVersionId) return
      const current = selectedVersionId ? versions.find((v) => v.id === selectedVersionId) : null
      if (current && (current.title !== title || current.body !== body)) {
        const ok = await appConfirm('当前版本有未保存的修改，切换后将丢失。是否继续？', {
          title: '未保存的修改',
        })
        if (!ok) return
      }
      if (saveTimer.current) clearTimeout(saveTimer.current)
      const row = versions.find((v) => v.id === id)
      if (!row) return
      setSelectedVersionId(id)
      setTitle(row.title)
      setBody(row.body)
      setJustSaved(false)
    },
    [versions, selectedVersionId, title, body],
  )

  const saveCopy = useCallback(async (opts?: { silent?: boolean }) => {
    if (!entryId || !selectedVersionId || !isDirty) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaving(true)
    setJustSaved(false)
    try {
      const updated = await apiPatch<CopyVersion>(
        `/api/entries/${entryId}/copy-versions/${selectedVersionId}`,
        { title, body },
      )
      const vers = await apiGet<CopyVersion[]>(`/api/entries/${entryId}/copy-versions`)
      setVersions(vers)
      if (updated.is_primary) {
        setEntry((prev) =>
          prev ? { ...prev, title: updated.title, body: updated.body } : prev,
        )
        window.dispatchEvent(new CustomEvent('xhs:entry-updated', { detail: { entryId } }))
      }
      setJustSaved(true)
      if (justSavedTimer.current) clearTimeout(justSavedTimer.current)
      justSavedTimer.current = setTimeout(() => setJustSaved(false), 2500)
      if (!opts?.silent) {
        showToast(updated.is_primary ? '已保存并同步主版本' : '已保存当前文案版本')
      }
    } catch (e) {
      if (!opts?.silent) showToast(parseApiErr(e))
    } finally {
      setSaving(false)
    }
  }, [entryId, selectedVersionId, isDirty, title, body, showToast])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (isDirty && !saving) void saveCopy()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isDirty, saving, saveCopy])

  useEffect(() => {
    if (!entryId || !selectedVersionId || !isDirty) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void saveCopy({ silent: true })
    }, 2000)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [title, body, entryId, selectedVersionId, isDirty, saveCopy])

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
      showToast('已生成新文案版本并设为主版本。请在「笔记管理」组合草稿后，于工作台载入发布。')
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
            每次「重新生成」会新增一条<strong>文案版本</strong>（左侧列表）。图片页据<strong>主版本</strong>生图入图稿池；在「笔记管理」将文案与图稿<strong>组合成草稿</strong>后，于「工作台」载入精修与发布。
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 text-xs font-medium text-slate-500">文案版本（条目内）</div>
            <ul className="max-h-48 space-y-1 overflow-y-auto pr-1 text-sm">
              {versions.map((v) => {
                const active = v.id === selectedVersionId
                const when = formatYmdHm(v.created_at)
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
                      v{vNumber(v.id)} · {sourceLabel(v.source)} · {when}
                      {v.is_primary ? (
                        <span className="ml-1 text-[10px] text-emerald-600">主</span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="rounded-xl border border-red-100 bg-[var(--color-brand-soft)] p-4 text-sm text-slate-700">
            <p className="mb-2">
              <strong className="text-brand">真人感</strong>：口语化断句、避免「综上所述」等套话；禁用夸张保过承诺。
            </p>
            <p className="mb-1.5 text-xs font-semibold text-slate-800">小红书 K12 规范（生成时切忌）</p>
            <ul className="max-h-36 space-y-1 overflow-y-auto text-[11px] leading-relaxed text-slate-600">
              {XHS_K12_COMPLIANCE_ITEMS.map((item) => (
                <li key={item} className="flex gap-1.5">
                  <span className="shrink-0 text-brand">·</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex min-h-[320px] flex-col rounded-xl border border-slate-200 bg-white p-5 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold text-slate-900">标题与正文</h2>
              {isDirty ? (
                <p className="mt-0.5 text-[11px] text-amber-600">有未保存的修改</p>
              ) : justSaved ? (
                <p className="mt-0.5 text-[11px] text-emerald-600">已保存</p>
              ) : saving ? (
                <p className="mt-0.5 text-[11px] text-slate-400">保存中…</p>
              ) : null}
            </div>
            <div className="flex flex-col items-end gap-1">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={!isDirty || saving || generating}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => void saveCopy()}
                >
                  {saving ? '保存中…' : '保存修改'}
                </button>
                <button
                  type="button"
                  disabled={generating || saving}
                  className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
                  onClick={() => void onGenerate()}
                >
                  {generating ? '生成中…' : '重新生成'}
                </button>
              </div>
              <span className="max-w-xs text-right text-[10px] text-slate-400">
                ⌘/Ctrl+S 快捷保存 · 停止输入 2 秒后也会自动保存
              </span>
              {competitorPasteForGenerate ? (
                <span className="max-w-xs text-right text-[10px] text-emerald-700">
                  重新生成将带上竞品「对标草稿」· 模版「{templateName}」
                </span>
              ) : (
                <span className="max-w-xs text-right text-[10px] text-slate-400">
                  重新生成按模版「{templateName}」
                </span>
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
            完成文案与配图后，请先在
            <Link to="/notes" className="font-medium text-brand hover:underline">
              笔记管理
            </Link>
            组合生成草稿，再在
            <Link to="/workbench" className="font-medium text-brand hover:underline">
              工作台
            </Link>
            载入精修与发布。
          </p>
        </div>
      </div>
    </div>
  )
}
