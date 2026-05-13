import { Link } from 'react-router-dom'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  apiUploadEntryImage,
  type CopyVersion,
  type DraftImage,
  type EntryDetail,
  type EntrySummary,
  type Template,
} from '../lib/api'
import { persistCurrentEntryId, resolveCurrentEntryId } from '../lib/currentEntry'

const MAX_FALLBACK = 18

function emitEntryUpdated(entryId: string) {
  window.dispatchEvent(new CustomEvent('xhs:entry-updated', { detail: { entryId } }))
}

function parseApiErr(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const raw = e.message
  if (raw.includes('draft_image_pool_full')) return `图稿池已满（最多 ${MAX_FALLBACK} 张，可在服务端环境变量调整）`
  if (raw.includes('image_locked_by_composed_snapshot'))
    return '该图稿被「笔记管理」组合草稿快照引用，无法删除（PRD §5.3）'
  const m = raw.match(/\{[\s\S]*"detail"\s*:\s*"([^"]+)"[\s\S]*\}\s*$/)
  if (m) return m[1]
  return raw
}

function buildGenParamSummary(entry: EntryDetail | null, tpl: Template | null): string {
  if (!entry) return ''
  const title = (entry.title || '').trim()
  const bodySnippet = (entry.body || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const meta = tpl?.copy_metadata
  let visual = ''
  if (meta && typeof meta === 'object' && meta !== null) {
    const hint = (meta as Record<string, unknown>).visual_style_hint
    if (typeof hint === 'string' && hint.trim()) visual = hint.trim()
  }
  const parts = [
    `【主文案摘要】${title ? `标题：${title}` : '（无标题）'}`,
    bodySnippet ? `正文节选：${bodySnippet}` : '',
    tpl
      ? `【模版】${tpl.name}；适用：${(tpl.scenario || '').slice(0, 120)}`
      : '【模版】未选择条目模版',
    visual ? `【视觉风格约束】${visual}` : '【视觉风格约束】（可在模版 copy_metadata.visual_style_hint 中维护）',
  ].filter(Boolean)
  return parts.join('\n\n')
}

async function placeholderPngFile(versionLabel: string, titleHint: string): Promise<File> {
  const c = document.createElement('canvas')
  c.width = 1080
  c.height = 1080
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('canvas unsupported')
  const g = ctx.createLinearGradient(0, 0, 1080, 1080)
  g.addColorStop(0, '#fce7f3')
  g.addColorStop(0.45, '#fff7ed')
  g.addColorStop(1, '#e0f2fe')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 1080, 1080)
  ctx.fillStyle = '#0f172a'
  ctx.font = '600 52px system-ui, sans-serif'
  ctx.fillText('图稿入池（示意）', 64, 100)
  ctx.font = '32px system-ui, sans-serif'
  ctx.fillStyle = '#475569'
  const t = titleHint.slice(0, 28) + (titleHint.length > 28 ? '…' : '')
  if (t) ctx.fillText(t, 64, 168)
  ctx.fillText(`来源文案版本：${versionLabel}`, 64, 220)
  ctx.font = '24px system-ui, sans-serif'
  ctx.fillStyle = '#94a3b8'
  ctx.fillText('本机未接生图模型时，用占位图演示 §5.3 溯源与入池', 64, 280)
  const blob = await new Promise<Blob>((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return new File([blob], `xhs-gen-${Date.now()}.png`, { type: 'image/png' })
}

export function ImagesPage() {
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [entryId, setEntryId] = useState<string | null>(null)
  const [entries, setEntries] = useState<EntrySummary[]>([])
  const [entry, setEntry] = useState<EntryDetail | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [versions, setVersions] = useState<CopyVersion[]>([])
  const [sourceVersionId, setSourceVersionId] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busyGen, setBusyGen] = useState(false)
  const [busyUpload, setBusyUpload] = useState(false)

  const poolLimit = entry?.draft_image_pool_limit ?? MAX_FALLBACK
  const count = entry?.images?.length ?? 0
  const atCap = count >= poolLimit

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

  const vLabel = useCallback(
    (id: string | null | undefined) => {
      if (!id) return '—'
      const i = sortedAsc.findIndex((v) => v.id === id)
      return i >= 0 ? `v${i + 1}` : id.slice(0, 8) + '…'
    },
    [sortedAsc],
  )

  const selectedTemplate = useMemo(() => {
    if (!entry?.selected_template_id) return null
    return templates.find((t) => t.id === entry.selected_template_id) ?? null
  }, [entry, templates])

  const paramSummary = useMemo(
    () => buildGenParamSummary(entry, selectedTemplate),
    [entry, selectedTemplate],
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
    const primary = vers.find((v) => v.is_primary)
    setSourceVersionId((cur) => {
      if (cur && vers.some((v) => v.id === cur)) return cur
      return primary?.id ?? vers[0]?.id ?? null
    })
    return d
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
    if (!entryId) return
    const on = (ev: Event) => {
      const e = ev as CustomEvent<{ entryId?: string }>
      if (e.detail?.entryId && e.detail.entryId !== entryId) return
      void reloadAll(entryId).catch(() => {})
    }
    window.addEventListener('xhs:entry-updated', on)
    return () => window.removeEventListener('xhs:entry-updated', on)
  }, [entryId, reloadAll])

  const sortedImages = useMemo(() => {
    if (!entry?.images) return []
    return [...entry.images].sort((a, b) => a.sort_order - b.sort_order)
  }, [entry])

  const applyReorder = async (ids: string[]) => {
    if (!entryId) return
    const d = await apiPut<EntryDetail>(`/api/entries/${entryId}/images/reorder`, { ids })
    setEntry(d)
    emitEntryUpdated(entryId)
  }

  const moveImage = async (img: DraftImage, dir: -1 | 1) => {
    if (!entryId) return
    const idx = sortedImages.findIndex((i) => i.id === img.id)
    const j = idx + dir
    if (idx < 0 || j < 0 || j >= sortedImages.length) return
    const next = [...sortedImages]
    const t = next[idx]
    next[idx] = next[j]
    next[j] = t
    try {
      await applyReorder(next.map((i) => i.id))
    } catch (e) {
      showToast(parseApiErr(e))
    }
  }

  const toggleInclude = async (img: DraftImage) => {
    if (!entryId) return
    try {
      await apiPatch<DraftImage>(`/api/entries/${entryId}/images/${img.id}`, {
        include_in_publish: !img.include_in_publish,
      })
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
    } catch (e) {
      showToast(parseApiErr(e))
    }
  }

  const setCover = async (img: DraftImage) => {
    if (!entryId) return
    try {
      await apiPatch<DraftImage>(`/api/entries/${entryId}/images/${img.id}`, {
        is_cover: true,
      })
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
    } catch (e) {
      showToast(parseApiErr(e))
    }
  }

  const removeImage = async (img: DraftImage) => {
    if (!entryId) return
    try {
      await apiDelete(`/api/entries/${entryId}/images/${img.id}`)
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
      showToast('已移除图稿')
    } catch (e) {
      showToast(parseApiErr(e))
    }
  }

  const genPlaceholderIntoPool = async () => {
    if (!entryId || !sourceVersionId || atCap) return
    setBusyGen(true)
    try {
      const ver = versions.find((v) => v.id === sourceVersionId)
      const label = ver ? vLabel(ver.id) : sourceVersionId.slice(0, 8)
      const titleHint = (ver?.title || entry?.title || '').trim()
      const file = await placeholderPngFile(label, titleHint)
      await apiUploadEntryImage(entryId, file, { sourceCopyVersionId: sourceVersionId })
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
      showToast('已生成示意图稿并入池（与工作台图稿池同源）')
    } catch (e) {
      showToast(parseApiErr(e))
    } finally {
      setBusyGen(false)
    }
  }

  const onPickLocal = async (files: FileList | null) => {
    if (!entryId || !files?.length) return
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (!arr.length) {
      showToast('请选择图片文件')
      return
    }
    const room = poolLimit - count
    if (room <= 0) {
      showToast(`图稿池已满（${poolLimit} 张）`)
      return
    }
    const batch = arr.slice(0, room)
    if (batch.length < arr.length) {
      showToast(`仅余 ${room} 个空位，已截取前 ${room} 张上传`)
    }
    setBusyUpload(true)
    try {
      let n = 0
      for (const f of batch) {
        await apiUploadEntryImage(entryId, f, { sourceCopyVersionId: sourceVersionId ?? undefined })
        n += 1
      }
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
      showToast(`已上传 ${n} 张并入池`)
    } catch (e) {
      showToast(parseApiErr(e))
    } finally {
      setBusyUpload(false)
    }
  }

  const addByUrl = async (url: string) => {
    if (!entryId || !url.trim() || atCap) return
    try {
      await apiPost<DraftImage>(`/api/entries/${entryId}/images`, {
        public_url: url.trim(),
        include_in_publish: true,
        source_copy_version_id: sourceVersionId,
      })
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
      showToast('已按 URL 入池')
    } catch (e) {
      showToast(parseApiErr(e))
    }
  }

  if (loadErr) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-red-100 bg-white p-8 text-slate-800 shadow-sm">
        <p className="font-medium text-red-600">加载失败</p>
        <p className="mt-2 text-sm text-slate-600">{loadErr}</p>
      </div>
    )
  }

  if (!entry || !entryId) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-slate-500">加载图片管理…</div>
    )
  }

  return (
    <div className="relative mx-auto max-w-5xl text-slate-900">
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      <div className="mb-4 max-w-3xl rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-white">
        <strong className="text-slate-200">图片生成与管理</strong>
        <br />
        结合<strong>当前条目主文案</strong>生成图稿；维护<strong>图稿池</strong>（勾选参与发布、顺序、封面标星）。同步至「
        <strong>工作台与发布</strong>」页的图片条；可在<strong>笔记管理</strong>与文案组合为新笔记。
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          当前条目
          <select
            className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
            value={entryId}
            onChange={(e) => {
              const id = e.target.value
              setEntryId(id)
              void reloadAll(id).catch((err) => showToast(parseApiErr(err)))
            }}
          >
            {entries.map((en) => (
              <option key={en.id} value={en.id}>
                {(en.title || '（无标题）').slice(0, 36)}
                {en.title && en.title.length > 36 ? '…' : ''}
              </option>
            ))}
          </select>
        </label>
        <Link to="/workbench" className="text-xs font-medium text-brand hover:underline">
          去工作台与发布
        </Link>
        <Link to="/copy" className="text-xs font-medium text-brand hover:underline">
          文案生成与管理
        </Link>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-slate-900">生图参数</h2>
          <p className="text-xs text-slate-500">由主文案关键信息 + 模版视觉风格约束拼接（§5.3 / 原型示意）</p>
          <textarea
            readOnly
            rows={8}
            className="w-full resize-y rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-800"
            value={paramSummary}
          />
          <label className="block text-xs text-slate-500">
            入池时记录的「来源文案版本」（切换后点「生成」将写入新溯源）
            <select
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
              value={sourceVersionId ?? ''}
              onChange={(e) => setSourceVersionId(e.target.value || null)}
            >
              {sortedAsc.length === 0 ? (
                <option value="">（暂无文案版本，请先在文案页生成或保存）</option>
              ) : null}
              {sortedAsc.map((v) => (
                <option key={v.id} value={v.id}>
                  {vLabel(v.id)}
                  {v.is_primary ? '（主版本）' : ''} · {(v.title || '无标题').slice(0, 40)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busyGen || atCap || !sourceVersionId}
            onClick={() => void genPlaceholderIntoPool()}
            className="w-full rounded-lg bg-brand py-2.5 text-sm font-medium text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyGen ? '生成中…' : atCap ? `已达上限（${poolLimit} 张）` : '生成新图稿（入池）'}
          </button>
          <p className="text-[0.7rem] leading-relaxed text-slate-400">
            未接本机生图模型时，入池为 1080×1080 占位 PNG，仍写入 <code className="text-slate-500">source_copy_version_id</code> 供列表展示与 PRD
            溯源。
          </p>
          <div className="border-t border-slate-100 pt-3">
            <p className="mb-2 text-xs font-medium text-slate-600">本地上传入池</p>
            <label className="inline-flex cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                className="hidden"
                disabled={busyUpload || atCap}
                onChange={(e) => {
                  void onPickLocal(e.target.files)
                  e.target.value = ''
                }}
              />
              {busyUpload ? '上传中…' : '选择本地图片'}
            </label>
            <UrlAddRow disabled={atCap} onAdd={(u) => void addByUrl(u)} />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-slate-900">当前条目图稿池</h3>
          <p className="mb-3 mt-1 text-xs text-slate-500">
            最多 {poolLimit} 张（与服务端校验一致）；勾选「参与发布」并排序。当前 {count}/{poolLimit}。
          </p>
          <ul className="max-h-[min(52vh,640px)] space-y-2 overflow-y-auto pr-1">
            {sortedImages.map((img, idx) => (
              <li
                key={img.id}
                className={`flex gap-3 rounded-lg border p-2 text-sm ${
                  previewUrl === img.public_url ? 'border-brand bg-rose-50/40' : 'border-slate-100 bg-slate-50/80'
                }`}
              >
                <button
                  type="button"
                  className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-white"
                  onClick={() => setPreviewUrl(img.public_url)}
                >
                  <img src={img.public_url} alt="" className="h-full w-full object-cover" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                      来源文案 {vLabel(img.source_copy_version_id)}
                    </span>
                    {img.is_cover && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                        封面
                      </span>
                    )}
                    {!img.include_in_publish && (
                      <span className="text-slate-400">不参与发布</span>
                    )}
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-slate-400">{img.public_url}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] hover:bg-slate-50"
                      onClick={() => void toggleInclude(img)}
                    >
                      {img.include_in_publish ? '取消发布' : '参与发布'}
                    </button>
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] hover:bg-slate-50"
                      onClick={() => void setCover(img)}
                    >
                      标为封面
                    </button>
                    <button
                      type="button"
                      disabled={idx === 0}
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] hover:bg-slate-50 disabled:opacity-40"
                      onClick={() => void moveImage(img, -1)}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      disabled={idx >= sortedImages.length - 1}
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] hover:bg-slate-50 disabled:opacity-40"
                      onClick={() => void moveImage(img, 1)}
                    >
                      下移
                    </button>
                    <button
                      type="button"
                      className="rounded border border-red-100 bg-white px-2 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
                      onClick={() => void removeImage(img)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {sortedImages.length === 0 && (
            <p className="mt-3 text-xs text-slate-400">暂无图稿，请使用左侧入池或在工作台上传。</p>
          )}
          <p className="mt-3 text-xs text-slate-400">
            每条图稿记录「来源文案版本」；切换主文案版本后再生图将带新版本标签（与 §5.3 一致）。
          </p>
          <div className="mt-3 aspect-square max-h-[280px] overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br from-rose-100 via-white to-sky-100">
            {previewUrl ? (
              <img src={previewUrl} alt="" className="h-full w-full object-contain bg-slate-900/5" />
            ) : (
              <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-slate-400">
                大图预览 · 点击左侧缩略图
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function UrlAddRow({ disabled, onAdd }: { disabled: boolean; onAdd: (url: string) => void }) {
  const [url, setUrl] = useState('')
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <input
        type="url"
        disabled={disabled}
        placeholder="https://… 配图 URL 入池"
        className="min-w-[8rem] flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm disabled:opacity-50"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button
        type="button"
        disabled={disabled || !url.trim()}
        className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-900 disabled:opacity-50"
        onClick={() => {
          onAdd(url)
          setUrl('')
        }}
      >
        URL 入池
      </button>
    </div>
  )
}
