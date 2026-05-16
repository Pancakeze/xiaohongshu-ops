import { Link } from 'react-router-dom'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatYmdHm } from '../lib/formatDate'
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  apiUploadEntryImage,
  type CopyVersion,
  type DraftImage,
  type DraftImagePool,
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
  if (raw.includes('draft_image_pool_full'))
    return `当前图稿池已满（每组最多 ${MAX_FALLBACK} 张）`
  if (raw.includes('cannot_delete_last_image_pool'))
    return '至少保留一个图稿池，无法删除'
  if (raw.includes('image_pool_locked_by_composed_snapshot'))
    return '该图稿池内有图稿被组合草稿引用，无法删除'
  if (raw.includes('image_locked_by_composed_snapshot'))
    return '该图稿被「笔记管理」组合草稿快照引用，无法删除（PRD §5.3）'
  const m = raw.match(/\{[\s\S]*"detail"\s*:\s*"([^"]+)"[\s\S]*\}\s*$/)
  if (m) return m[1]
  return raw
}

function buildGenParamSummary(
  entry: EntryDetail | null,
  tpl: Template | null,
  sourceVer: CopyVersion | null,
  versionTag: string | null,
): string {
  if (!entry) return ''
  const title = (sourceVer?.title ?? entry.title ?? '').trim()
  const bodyRaw = (sourceVer?.body ?? entry.body ?? '').replace(/\s+/g, ' ').trim()
  const bodySnippet = bodyRaw.slice(0, 200)
  const meta = tpl?.copy_metadata
  let visual = ''
  if (meta && typeof meta === 'object' && meta !== null) {
    const hint = (meta as Record<string, unknown>).visual_style_hint
    if (typeof hint === 'string' && hint.trim()) visual = hint.trim()
  }
  const parts = [
    versionTag ? `【生图参考文案】${versionTag}` : null,
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
  const [entry, setEntry] = useState<EntryDetail | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [versions, setVersions] = useState<CopyVersion[]>([])
  const [sourceVersionId, setSourceVersionId] = useState<string | null>(null)
  const [activePoolId, setActivePoolId] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busyGen, setBusyGen] = useState(false)
  const [busyUpload, setBusyUpload] = useState(false)
  const [busyPool, setBusyPool] = useState(false)

  const poolLimit = entry?.draft_image_pool_limit ?? MAX_FALLBACK

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

  const sourceVersionRow = useMemo(
    () => (sourceVersionId ? versions.find((v) => v.id === sourceVersionId) ?? null : null),
    [versions, sourceVersionId],
  )

  const sourceVersionTag = useMemo(() => {
    if (!sourceVersionId) return null
    const i = sortedAsc.findIndex((v) => v.id === sourceVersionId)
    const lab = i >= 0 ? `v${i + 1}` : `${sourceVersionId.slice(0, 8)}…`
    return lab
  }, [sourceVersionId, sortedAsc])

  const paramSummary = useMemo(
    () => buildGenParamSummary(entry, selectedTemplate, sourceVersionRow, sourceVersionTag),
    [entry, selectedTemplate, sourceVersionRow, sourceVersionTag],
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
    const pools = d.image_pools ?? []
    setActivePoolId((cur) => {
      if (cur && pools.some((p) => p.id === cur)) return cur
      return pools[0]?.id ?? null
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
    const on = (ev: Event) => {
      const e = ev as CustomEvent<{ entryId?: string }>
      if (e.detail?.entryId && e.detail.entryId !== entryId) return
      void reloadAll(entryId).catch(() => {})
    }
    window.addEventListener('xhs:entry-updated', on)
    return () => window.removeEventListener('xhs:entry-updated', on)
  }, [entryId, reloadAll])

  const sortedPools = useMemo(() => {
    const pools = entry?.image_pools ?? []
    return [...pools].sort((a, b) => a.sort_order - b.sort_order)
  }, [entry])

  const activePool = useMemo(
    () => sortedPools.find((p) => p.id === activePoolId) ?? null,
    [sortedPools, activePoolId],
  )

  const poolImages = useMemo(() => {
    if (!entry?.images || !activePoolId) return []
    return [...entry.images]
      .filter((im) => im.pool_id === activePoolId)
      .sort((a, b) => a.sort_order - b.sort_order)
  }, [entry, activePoolId])

  const count = activePool?.image_count ?? poolImages.length
  const atCap = count >= poolLimit

  const uploadOpts = useMemo(
    () => ({
      imagePoolId: activePoolId ?? undefined,
      sourceCopyVersionId: sourceVersionId ?? undefined,
    }),
    [activePoolId, sourceVersionId],
  )

  const applyReorder = async (ids: string[]) => {
    if (!entryId) return
    const d = await apiPut<EntryDetail>(`/api/entries/${entryId}/images/reorder`, { ids })
    setEntry(d)
    emitEntryUpdated(entryId)
  }

  const moveImage = async (img: DraftImage, dir: -1 | 1) => {
    if (!entryId) return
    const idx = poolImages.findIndex((i) => i.id === img.id)
    const j = idx + dir
    if (idx < 0 || j < 0 || j >= poolImages.length) return
    const next = [...poolImages]
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

  const createPool = async () => {
    if (!entryId) return
    const n = sortedPools.length + 1
    const name = window.prompt('新建图稿池名称', `图稿池 ${n}`)
    if (!name?.trim()) return
    setBusyPool(true)
    try {
      const pool = await apiPost<DraftImagePool>(`/api/entries/${entryId}/image-pools`, {
        name: name.trim(),
      })
      await reloadAll(entryId)
      setActivePoolId(pool.id)
      showToast('已新建图稿池')
    } catch (e) {
      showToast(parseApiErr(e))
    } finally {
      setBusyPool(false)
    }
  }

  const renamePool = async (pool: DraftImagePool) => {
    if (!entryId) return
    const name = window.prompt('重命名图稿池', pool.name)
    if (!name?.trim() || name.trim() === pool.name) return
    setBusyPool(true)
    try {
      await apiPatch<DraftImagePool>(`/api/entries/${entryId}/image-pools/${pool.id}`, {
        name: name.trim(),
      })
      await reloadAll(entryId)
      showToast('已重命名')
    } catch (e) {
      showToast(parseApiErr(e))
    } finally {
      setBusyPool(false)
    }
  }

  const deletePool = async (pool: DraftImagePool) => {
    if (!entryId) return
    if (sortedPools.length <= 1) {
      showToast('至少保留一个图稿池')
      return
    }
    const msg =
      pool.image_count > 0
        ? `确定删除「${pool.name}」及其 ${pool.image_count} 张图稿？`
        : `确定删除「${pool.name}」？`
    if (!window.confirm(msg)) return
    setBusyPool(true)
    try {
      await apiDelete(`/api/entries/${entryId}/image-pools/${pool.id}`)
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
      showToast('已删除图稿池')
    } catch (e) {
      showToast(parseApiErr(e))
    } finally {
      setBusyPool(false)
    }
  }

  const genPlaceholderIntoPool = async () => {
    if (!entryId || !sourceVersionId || !activePoolId || atCap) return
    setBusyGen(true)
    try {
      const ver = versions.find((v) => v.id === sourceVersionId)
      const label = ver ? vLabel(ver.id) : sourceVersionId.slice(0, 8)
      const titleHint = (ver?.title || entry?.title || '').trim()
      const file = await placeholderPngFile(label, titleHint)
      await apiUploadEntryImage(entryId, file, uploadOpts)
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
      showToast(`已生成示意图稿（${Math.min(count + 1, poolLimit)}/${poolLimit}）`)
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
        await apiUploadEntryImage(entryId, f, uploadOpts)
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
    if (!entryId || !url.trim() || !activePoolId || atCap) return
    try {
      await apiPost<DraftImage>(`/api/entries/${entryId}/images`, {
        public_url: url.trim(),
        pool_id: activePoolId,
        include_in_publish: true,
        source_copy_version_id: sourceVersionId ?? undefined,
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
    <div className="relative mx-auto max-w-6xl text-slate-900">
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      <div className="mb-4 max-w-3xl rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-white">
        <strong className="text-slate-200">图片生成与管理</strong>
        <br />
        左侧管理<strong>图稿池分组</strong>（每组最多 {poolLimit} 张）；中栏在生图参数下选择参考文案版本；右侧维护当前池图稿。完成后在「
        <strong>笔记管理</strong>」组合草稿，于「工作台与发布」载入发布。
      </div>

      <div className="mb-4 flex flex-wrap gap-3 text-xs">
        <Link to="/copy" className="text-xs font-medium text-brand hover:underline">
          文案生成与管理
        </Link>
        <span className="text-slate-300">·</span>
        <Link to="/notes" className="text-xs font-medium text-brand hover:underline">
          笔记管理
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[220px_1fr_1.15fr]">
        <aside className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">图稿池</h2>
            <button
              type="button"
              disabled={busyPool}
              onClick={() => void createPool()}
              className="rounded-lg border border-brand px-2 py-1 text-[11px] font-medium text-brand hover:bg-rose-50 disabled:opacity-50"
            >
              新建
            </button>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
            每组最多 {poolLimit} 张；切换池后在中栏生成或上传。
          </p>
          <ul className="max-h-[min(52vh,560px)] space-y-1 overflow-y-auto pr-1 text-sm">
            {sortedPools.length === 0 ? (
              <li className="px-2 py-2 text-xs text-slate-400">暂无图稿池</li>
            ) : (
              sortedPools.map((p) => {
                const active = p.id === activePoolId
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActivePoolId(p.id)
                        setPreviewUrl(null)
                      }}
                      className={`w-full rounded-lg px-2 py-2 text-left ${
                        active
                          ? 'bg-slate-100 font-medium text-slate-900'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <span className="block truncate">{p.name}</span>
                      <span className="mt-0.5 block text-[10px] text-slate-400">
                        {p.image_count}/{poolLimit} 张
                      </span>
                    </button>
                    <div className="mt-0.5 flex gap-2 px-2 pb-1 text-[10px]">
                      <button
                        type="button"
                        disabled={busyPool}
                        className="text-brand hover:underline disabled:opacity-50"
                        onClick={() => void renamePool(p)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={busyPool || sortedPools.length <= 1}
                        className="text-red-600 hover:underline disabled:opacity-40"
                        onClick={() => void deletePool(p)}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                )
              })
            )}
          </ul>
        </aside>

        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-slate-900">生图参数</h2>
          <p className="text-xs text-slate-500">
            由所选参考文案 + 模版视觉风格拼接（入当前池：
            <strong>{activePool?.name ?? '—'}</strong>）
          </p>
          <textarea
            readOnly
            rows={6}
            className="w-full resize-y rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-800"
            value={paramSummary}
          />

          <div className="border-t border-slate-100 pt-3">
            <label className="mb-1 block text-xs font-medium text-slate-600">参考文案版本</label>
            <p className="mb-2 text-[11px] text-slate-500">仅用于生图提示词，不绑定图稿归属。</p>
            {sortedAsc.length === 0 ? (
              <p className="text-xs text-slate-400">暂无文案版本，请先到「文案生成与管理」创建。</p>
            ) : (
              <select
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                value={sourceVersionId ?? ''}
                onChange={(e) => setSourceVersionId(e.target.value || null)}
              >
                {sortedAsc.map((v) => (
                  <option key={v.id} value={v.id}>
                    {vLabel(v.id)}
                    {v.is_primary ? ' · 主' : ''} · {formatYmdHm(v.created_at)} ·{' '}
                    {(v.title || '无标题').slice(0, 24)}
                  </option>
                ))}
              </select>
            )}
          </div>

          <button
            type="button"
            disabled={busyGen || atCap || !sourceVersionId || !activePoolId}
            onClick={() => void genPlaceholderIntoPool()}
            className="w-full rounded-lg bg-brand py-2.5 text-sm font-medium text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyGen
              ? '生成中…'
              : atCap
                ? `当前池已满（${poolLimit} 张）`
                : `生成新图稿（${count}/${poolLimit}）`}
          </button>
          <p className="text-[0.7rem] leading-relaxed text-slate-400">
            未接本机生图模型时，入池为 1080×1080 占位 PNG（示意）。
          </p>
          <div className="border-t border-slate-100 pt-3">
            <p className="mb-2 text-xs font-medium text-slate-600">本地上传入当前池</p>
            <label className="inline-flex cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                className="hidden"
                disabled={busyUpload || atCap || !activePoolId}
                onChange={(e) => {
                  void onPickLocal(e.target.files)
                  e.target.value = ''
                }}
              />
              {busyUpload ? '上传中…' : '选择本地图片'}
            </label>
            <UrlAddRow disabled={atCap || !activePoolId} onAdd={(u) => void addByUrl(u)} />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            {activePool ? activePool.name : '图稿列表'}
          </h3>
          <p className="mb-3 mt-1 text-xs text-slate-500">
            本池最多 {poolLimit} 张；勾选「参与发布」并排序。当前 {count}/{poolLimit}。
          </p>
          <ul className="max-h-[min(52vh,640px)] space-y-2 overflow-y-auto pr-1">
            {poolImages.map((img, idx) => (
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
                      disabled={idx >= poolImages.length - 1}
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
          {poolImages.length === 0 && (
            <p className="mt-3 text-xs text-slate-400">本池暂无图稿，请在中栏生成或上传。</p>
          )}
          <p className="mt-3 text-xs text-slate-400">
            各池图稿可在「笔记管理」组合草稿时跨池勾选。
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
