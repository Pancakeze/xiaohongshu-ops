import { Link, useSearchParams } from 'react-router-dom'
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
import { appConfirm, appPrompt } from '../lib/appDialog'
import { confirmDeleteDraftImage } from '../lib/draftImageDelete'
import { draftImageDisplayName } from '../lib/draftImage'
import { GenParamRichEditor } from '../components/GenParamRichEditor'
import {
  DEFAULT_PLACEHOLDER_STYLE,
  FONT_FAMILIES,
  FONT_SIZES,
  genParamPngFile,
  genParamPreviewDataUrl,
  mergePlaceholderStyle,
  normalizeGenParamContent,
  plainTextToGenParamHtml,
  type PlaceholderStyle,
} from '../lib/genParamCanvas'
import { GoogleImagesPanel } from './GoogleImagesPage'

type ImagesTab = 'pool' | 'google'

function ImagesTabBar({ tab, onChange }: { tab: ImagesTab; onChange: (t: ImagesTab) => void }) {
  const base =
    'rounded-lg px-4 py-2 text-sm font-medium transition-colors border'
  return (
    <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label="图片生成方式">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'pool'}
        className={`${base} ${
          tab === 'pool'
            ? 'border-brand bg-brand-soft text-brand-dark'
            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
        }`}
        onClick={() => onChange('pool')}
      >
        图稿池
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'google'}
        className={`${base} ${
          tab === 'google'
            ? 'border-brand bg-brand-soft text-brand-dark'
            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
        }`}
        onClick={() => onChange('google')}
      >
        Google 生图（聊天式）
      </button>
    </div>
  )
}

const MAX_FALLBACK = 18
const LS_GEN_PARAMS = 'xhs:entry_gen_params:v1'
const LS_PLACEHOLDER_STYLE = 'xhs:entry_placeholder_style:v1'

const BG_PRESETS: { value: string; label: string }[] = [
  { value: 'gradient-default', label: '粉彩渐变' },
  { value: '#ffffff', label: '纯白' },
  { value: '#fce7f3', label: '浅粉' },
  { value: '#fff7ed', label: '暖杏' },
  { value: '#e0f2fe', label: '浅蓝' },
  { value: '#ecfdf5', label: '浅绿' },
  { value: '#f8fafc', label: '浅灰' },
  { value: '#0f172a', label: '深色' },
]

type SavedGenParams = Record<string, { text: string; autoKey: string }>
type SavedPlaceholderStyles = Record<string, PlaceholderStyle>

function loadSavedPlaceholderStyle(entryId: string): PlaceholderStyle | null {
  try {
    const raw = localStorage.getItem(LS_PLACEHOLDER_STYLE)
    if (!raw) return null
    const v = JSON.parse(raw) as SavedPlaceholderStyles
    const row = v[entryId]
    if (!row || typeof row !== 'object') return null
    return mergePlaceholderStyle(row)
  } catch {
    return null
  }
}

function persistPlaceholderStyle(entryId: string, style: PlaceholderStyle): void {
  try {
    const raw = localStorage.getItem(LS_PLACEHOLDER_STYLE)
    const v: SavedPlaceholderStyles = raw ? (JSON.parse(raw) as SavedPlaceholderStyles) : {}
    v[entryId] = style
    localStorage.setItem(LS_PLACEHOLDER_STYLE, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

function loadSavedGenParams(entryId: string): { text: string; autoKey: string } | null {
  try {
    const raw = localStorage.getItem(LS_GEN_PARAMS)
    if (!raw) return null
    const v = JSON.parse(raw) as SavedGenParams
    const row = v[entryId]
    if (!row || typeof row.text !== 'string') return null
    return { text: row.text, autoKey: typeof row.autoKey === 'string' ? row.autoKey : '' }
  } catch {
    return null
  }
}

function persistGenParams(entryId: string, text: string, autoKey: string): void {
  try {
    const raw = localStorage.getItem(LS_GEN_PARAMS)
    const v: SavedGenParams = raw ? (JSON.parse(raw) as SavedGenParams) : {}
    v[entryId] = { text, autoKey }
    localStorage.setItem(LS_GEN_PARAMS, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

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
    return '删除图稿池失败，请稍后重试'
  if (raw.includes('image_locked_by_composed_snapshot'))
    return '删除图稿失败，请稍后重试'
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

export function ImagesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: ImagesTab = searchParams.get('tab') === 'google' ? 'google' : 'pool'
  const setTab = useCallback(
    (next: ImagesTab) => {
      if (next === 'google') setSearchParams({ tab: 'google' }, { replace: true })
      else setSearchParams({}, { replace: true })
    },
    [setSearchParams],
  )

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
  const [genParamHtml, setGenParamHtml] = useState('<p><br></p>')
  const [placeholderStyle, setPlaceholderStyle] = useState<PlaceholderStyle>(DEFAULT_PLACEHOLDER_STYLE)
  const [placeholderPreviewUrl, setPlaceholderPreviewUrl] = useState('')
  const [previewRendering, setPreviewRendering] = useState(false)

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

  const autoGenParams = useMemo(
    () => buildGenParamSummary(entry, selectedTemplate, sourceVersionRow, sourceVersionTag),
    [entry, selectedTemplate, sourceVersionRow, sourceVersionTag],
  )

  const genParamAutoKey = useMemo(
    () => `${entryId ?? ''}|${sourceVersionId ?? ''}|${entry?.selected_template_id ?? ''}`,
    [entryId, sourceVersionId, entry?.selected_template_id],
  )

  const autoGenParamsHtml = useMemo(
    () => plainTextToGenParamHtml(autoGenParams),
    [autoGenParams],
  )

  useEffect(() => {
    if (!entryId) return
    const saved = loadSavedGenParams(entryId)
    if (saved?.autoKey === genParamAutoKey) {
      setGenParamHtml(normalizeGenParamContent(saved.text))
      return
    }
    setGenParamHtml(autoGenParamsHtml)
  }, [entryId, genParamAutoKey, autoGenParamsHtml])

  useEffect(() => {
    if (!entryId) return
    setPlaceholderStyle(loadSavedPlaceholderStyle(entryId) ?? DEFAULT_PLACEHOLDER_STYLE)
  }, [entryId])

  const updatePlaceholderStyle = useCallback(
    (patch: Partial<PlaceholderStyle>) => {
      setPlaceholderStyle((prev) => {
        const next = { ...prev, ...patch }
        if (entryId) persistPlaceholderStyle(entryId, next)
        return next
      })
    },
    [entryId],
  )

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      setPreviewRendering(true)
      void genParamPreviewDataUrl(genParamHtml, placeholderStyle, 240)
        .then((url) => {
          if (!cancelled) setPlaceholderPreviewUrl(url)
        })
        .catch(() => {
          if (!cancelled) setPlaceholderPreviewUrl('')
        })
        .finally(() => {
          if (!cancelled) setPreviewRendering(false)
        })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [genParamHtml, placeholderStyle])

  const persistGenParamHtml = useCallback(
    (html: string) => {
      setGenParamHtml(html)
      if (entryId) persistGenParams(entryId, html, genParamAutoKey)
    },
    [entryId, genParamAutoKey],
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

  const selectedPoolImage = useMemo(
    () => poolImages.find((im) => im.public_url === previewUrl) ?? null,
    [poolImages, previewUrl],
  )

  useEffect(() => {
    if (poolImages.length === 0) {
      setPreviewUrl(null)
      return
    }
    if (!previewUrl || !poolImages.some((im) => im.public_url === previewUrl)) {
      setPreviewUrl(poolImages[0].public_url)
    }
  }, [poolImages, previewUrl])

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

  const renameImage = async (img: DraftImage) => {
    if (!entryId) return
    const idx = poolImages.findIndex((i) => i.id === img.id)
    const fallback = idx >= 0 ? idx + 1 : 1
    const current = draftImageDisplayName(img, fallback)
    const raw = await appPrompt('图稿名称', img.name?.trim() ? current : '', { title: '重命名图稿' })
    if (raw === null) return
    try {
      await apiPatch<DraftImage>(`/api/entries/${entryId}/images/${img.id}`, {
        name: raw.trim(),
      })
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
      showToast('已更新图稿名称')
    } catch (e) {
      showToast(parseApiErr(e))
    }
  }

  const removeImage = async (img: DraftImage) => {
    if (!entryId) return
    if (!(await confirmDeleteDraftImage(img))) return
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
    const name = await appPrompt('新建图稿池名称', `图稿池 ${n}`, { title: '新建图稿池' })
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
    const name = await appPrompt('重命名图稿池', pool.name, { title: '重命名图稿池' })
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
    const lockedInPool =
      entry?.images.filter((i) => i.pool_id === pool.id && i.composed_snapshot_locked).length ?? 0
    const snapNote =
      lockedInPool > 0
        ? `\n其中 ${lockedInPool} 张被组合草稿引用，删除后将从相关草稿快照中移除。`
        : ''
    const msg =
      pool.image_count > 0
        ? `确定删除「${pool.name}」及其 ${pool.image_count} 张图稿？${snapNote}`
        : `确定删除「${pool.name}」？`
    const ok = await appConfirm(msg, { title: '删除图稿池', danger: true, confirmLabel: '删除' })
    if (!ok) return
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
      const file = await genParamPngFile(genParamHtml, placeholderStyle)
      const uploaded = await apiUploadEntryImage(entryId, file, uploadOpts)
      await reloadAll(entryId)
      setPreviewUrl(uploaded.public_url)
      emitEntryUpdated(entryId)
      showToast(`已生成并入池（${Math.min(count + 1, poolLimit)}/${poolLimit}）`)
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
    const trimmed = url.trim()
    if (!trimmed) return
    if (!entryId) {
      showToast('请先在「图稿池」标签加载条目')
      throw new Error('entry_not_loaded')
    }
    if (!activePoolId) {
      showToast('请先在「图稿池」选择或新建图稿池')
      throw new Error('pool_not_selected')
    }
    if (atCap) {
      showToast(`当前池已满（${poolLimit} 张）`)
      throw new Error('pool_full')
    }
    try {
      await apiPost<DraftImage>(`/api/entries/${entryId}/images`, {
        public_url: trimmed,
        pool_id: activePoolId,
        include_in_publish: true,
        source_copy_version_id: sourceVersionId ?? undefined,
      })
      await reloadAll(entryId)
      emitEntryUpdated(entryId)
      showToast('已入图稿池')
    } catch (e) {
      showToast(parseApiErr(e))
      throw e
    }
  }

  const pageShellStart = (
    <>
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      <ImagesTabBar tab={tab} onChange={setTab} />
    </>
  )

  if (loadErr && tab === 'pool') {
    return (
      <div className="relative mx-auto max-w-6xl text-slate-900">
        {pageShellStart}
        <div className="mx-auto max-w-3xl rounded-xl border border-red-100 bg-white p-8 text-slate-800 shadow-sm">
          <p className="font-medium text-red-600">加载失败</p>
          <p className="mt-2 text-sm text-slate-600">{loadErr}</p>
        </div>
      </div>
    )
  }

  if ((!entry || !entryId) && tab === 'pool') {
    return (
      <div className="relative mx-auto max-w-6xl text-slate-900">
        {pageShellStart}
        <div className="hidden" aria-hidden>
          <GoogleImagesPanel onSwitchToPool={() => setTab('pool')} onAddToPool={addByUrl} />
        </div>
        <div className="flex min-h-[40vh] items-center justify-center text-slate-500">加载图稿池…</div>
      </div>
    )
  }

  return (
    <div className="relative mx-auto max-w-6xl text-slate-900">
      {pageShellStart}

      <div className={tab === 'google' ? undefined : 'hidden'} aria-hidden={tab !== 'google'}>
        <GoogleImagesPanel onSwitchToPool={() => setTab('pool')} onAddToPool={addByUrl} />
      </div>

      <div className={tab === 'pool' ? undefined : 'hidden'} aria-hidden={tab !== 'pool'}>
      <div className="mb-4 flex flex-wrap gap-3 text-xs">
        <Link to="/copy" className="text-xs font-medium text-brand hover:underline">
          文案管理
        </Link>
        <span className="text-slate-300">·</span>
        <Link to="/notes" className="text-xs font-medium text-brand hover:underline">
          笔记管理
        </Link>
      </div>

      {/* 图稿池切换 */}
      <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {sortedPools.length === 0 ? (
              <span className="text-sm text-slate-400">暂无图稿池</span>
            ) : (
              sortedPools.map((p) => {
                const active = p.id === activePoolId
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setActivePoolId(p.id)
                      setPreviewUrl(null)
                    }}
                    className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                      active
                        ? 'border-brand bg-brand-soft font-medium text-brand-dark'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <span className="block max-w-[10rem] truncate">{p.name}</span>
                    <span className="mt-0.5 block text-[10px] font-normal opacity-70">
                      {p.image_count}/{poolLimit}
                    </span>
                  </button>
                )
              })
            )}
            <button
              type="button"
              disabled={busyPool}
              onClick={() => void createPool()}
              className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500 hover:border-brand hover:text-brand disabled:opacity-50"
            >
              + 新建池
            </button>
          </div>
          {activePool ? (
            <div className="flex shrink-0 items-center gap-2 text-xs">
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">
                {count}/{poolLimit} 张
              </span>
              <button
                type="button"
                disabled={busyPool}
                className="text-brand hover:underline disabled:opacity-50"
                onClick={() => void renamePool(activePool)}
              >
                重命名
              </button>
              <button
                type="button"
                disabled={busyPool || sortedPools.length <= 1}
                className="text-red-600 hover:underline disabled:opacity-40"
                onClick={() => void deletePool(activePool)}
              >
                删除
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        {/* 左侧：生成与入池 */}
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900">生成图稿</h2>
            <p className="mt-1 text-xs text-slate-500">
              编辑文字实时预览，生成后写入「{activePool?.name ?? '—'}」
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-slate-700">生图参数</label>
                <button
                  type="button"
                  className="shrink-0 text-xs text-brand hover:underline disabled:opacity-40"
                  disabled={!entryId || genParamHtml === autoGenParamsHtml}
                  onClick={() => persistGenParamHtml(autoGenParamsHtml)}
                >
                  恢复自动拼接
                </button>
              </div>
              <GenParamRichEditor
                value={genParamHtml}
                onChange={persistGenParamHtml}
                minHeight="11rem"
              />
              <p className="text-[10px] text-slate-400">
                支持富文本：选中文字后可改字体、字号、加粗、颜色等；也可在下方设置默认样式。
              </p>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700">参考文案版本</label>
                {sortedAsc.length === 0 ? (
                  <p className="text-xs text-slate-400">请先到「文案管理」创建版本</p>
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
            </div>

            <div className="flex flex-col items-center sm:sticky sm:top-4 sm:self-start">
              <p className="mb-2 w-full text-center text-[11px] font-medium text-slate-500">
                实时预览{previewRendering ? ' · 渲染中…' : ''}
              </p>
              {placeholderPreviewUrl ? (
                <img
                  src={placeholderPreviewUrl}
                  alt="图稿预览"
                  className="aspect-square w-full max-w-[160px] rounded-xl border border-slate-200 bg-slate-50 object-cover shadow-sm"
                />
              ) : (
                <div className="flex aspect-square w-full max-w-[160px] items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-2 text-center text-[11px] text-slate-400">
                  {previewRendering ? '渲染中…' : '输入内容后预览'}
                </div>
              )}
              <p className="mt-2 text-center text-[10px] leading-relaxed text-slate-400">1080×1080</p>
            </div>
          </div>

          <details className="group rounded-lg border border-slate-200 bg-slate-50/60">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-xs font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
              <span>样式设置</span>
              <span className="text-[10px] font-normal text-slate-400 group-open:hidden">展开</span>
              <span className="hidden text-[10px] font-normal text-slate-400 group-open:inline">收起</span>
            </summary>
            <div className="space-y-4 border-t border-slate-200/80 px-4 pb-4 pt-3">
              <div>
                <label className="mb-2 block text-[11px] text-slate-500">背景色</label>
                <div className="flex flex-wrap gap-1.5">
                  {BG_PRESETS.map((preset) => {
                    const active = placeholderStyle.bgColor === preset.value
                    const swatchStyle =
                      preset.value === 'gradient-default'
                        ? {
                            background:
                              'linear-gradient(135deg, #fce7f3 0%, #fff7ed 45%, #e0f2fe 100%)',
                          }
                        : { backgroundColor: preset.value }
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        title={preset.label}
                        aria-label={preset.label}
                        aria-pressed={active}
                        className={`h-7 w-7 rounded-md border-2 transition-shadow ${
                          active
                            ? 'border-brand ring-1 ring-brand/30'
                            : 'border-slate-200 hover:border-slate-300'
                        }`}
                        style={swatchStyle}
                        onClick={() => updatePlaceholderStyle({ bgColor: preset.value })}
                      />
                    )
                  })}
                  <label
                    className={`relative flex h-7 w-7 cursor-pointer items-center justify-center overflow-hidden rounded-md border-2 ${
                      !BG_PRESETS.some((p) => p.value === placeholderStyle.bgColor)
                        ? 'border-brand ring-1 ring-brand/30'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                    title="自定义颜色"
                  >
                    <span className="pointer-events-none text-[8px] text-slate-500">自定</span>
                    <input
                      type="color"
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      value={
                        placeholderStyle.bgColor.startsWith('#') &&
                        placeholderStyle.bgColor.length === 7
                          ? placeholderStyle.bgColor
                          : '#fce7f3'
                      }
                      onChange={(e) => updatePlaceholderStyle({ bgColor: e.target.value })}
                    />
                  </label>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-[11px] text-slate-500">默认字体</label>
                  <select
                    className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
                    value={placeholderStyle.fontFamily}
                    onChange={(e) => updatePlaceholderStyle({ fontFamily: e.target.value })}
                  >
                    {FONT_FAMILIES.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] text-slate-500">默认字号</label>
                  <select
                    className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
                    value={placeholderStyle.fontSize}
                    onChange={(e) =>
                      updatePlaceholderStyle({ fontSize: Number(e.target.value) || DEFAULT_PLACEHOLDER_STYLE.fontSize })
                    }
                  >
                    {FONT_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {s}px
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] text-slate-500">默认字重</label>
                  <div className="flex gap-1">
                    {(
                      [
                        { value: 'normal', label: '常规' },
                        { value: 'bold', label: '粗体' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={placeholderStyle.fontWeight === opt.value}
                        className={`flex-1 rounded-md border py-1.5 text-xs font-medium ${
                          placeholderStyle.fontWeight === opt.value
                            ? 'border-brand bg-brand-soft text-brand-dark'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                        onClick={() => updatePlaceholderStyle({ fontWeight: opt.value })}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] text-slate-500">默认文字色</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      className="h-8 w-10 cursor-pointer rounded border border-slate-200 bg-white"
                      value={placeholderStyle.textColor}
                      onChange={(e) => updatePlaceholderStyle({ textColor: e.target.value })}
                    />
                    <span className="font-mono text-[10px] text-slate-500">{placeholderStyle.textColor}</span>
                  </div>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-[11px] text-slate-500">水平</label>
                  <div className="flex gap-1">
                    {(
                      [
                        { value: 'left', label: '左' },
                        { value: 'center', label: '中' },
                        { value: 'right', label: '右' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={placeholderStyle.titleAlign === opt.value}
                        className={`flex-1 rounded-md border py-1.5 text-xs font-medium ${
                          placeholderStyle.titleAlign === opt.value
                            ? 'border-brand bg-brand-soft text-brand-dark'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                        onClick={() => updatePlaceholderStyle({ titleAlign: opt.value })}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] text-slate-500">垂直</label>
                  <div className="flex gap-1">
                    {(
                      [
                        { value: 'top', label: '靠上' },
                        { value: 'middle', label: '居中' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={placeholderStyle.contentVAlign === opt.value}
                        className={`flex-1 rounded-md border py-1.5 text-xs font-medium ${
                          placeholderStyle.contentVAlign === opt.value
                            ? 'border-brand bg-brand-soft text-brand-dark'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                        onClick={() => updatePlaceholderStyle({ contentVAlign: opt.value })}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </details>

          <div className="space-y-3 border-t border-slate-100 pt-4">
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
                  : `生成并入池（${count}/${poolLimit}）`}
            </button>
            <div className="flex flex-wrap items-center gap-2">
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
                {busyUpload ? '上传中…' : '本地上传'}
              </label>
              <UrlAddRow disabled={atCap || !activePoolId} onAdd={(u) => void addByUrl(u)} compact />
            </div>
          </div>
        </section>

        {/* 右侧：图稿浏览与管理 */}
        <section className="flex flex-col rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-slate-900">
              {activePool?.name ?? '图稿列表'}
            </h2>
            <p className="mt-1 text-xs text-slate-500">点击缩略图预览，下方操作当前选中图稿</p>
          </div>

          <div className="mb-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-900/5">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt=""
                className="mx-auto aspect-square max-h-[min(42vh,360px)] w-full object-contain"
              />
            ) : (
              <div className="flex aspect-square max-h-[280px] w-full items-center justify-center text-sm text-slate-400">
                暂无图稿，请在左侧生成或上传
              </div>
            )}
          </div>

          {selectedPoolImage ? (
            <div className="mb-4">
              <p className="mb-2 truncate text-xs font-medium text-slate-700">
                {draftImageDisplayName(
                  selectedPoolImage,
                  poolImages.findIndex((i) => i.id === selectedPoolImage.id) + 1,
                )}
              </p>
            <div className="flex flex-wrap gap-1.5 rounded-lg bg-slate-50 p-2.5">
              {selectedPoolImage.is_cover && (
                <span className="mr-1 self-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                  封面
                </span>
              )}
              {!selectedPoolImage.include_in_publish && (
                <span className="mr-1 self-center text-[10px] text-slate-400">不参与发布</span>
              )}
              <button
                type="button"
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] hover:bg-slate-50"
                onClick={() => void toggleInclude(selectedPoolImage)}
              >
                {selectedPoolImage.include_in_publish ? '取消发布' : '参与发布'}
              </button>
              <button
                type="button"
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] hover:bg-slate-50"
                onClick={() => void setCover(selectedPoolImage)}
              >
                标为封面
              </button>
              <button
                type="button"
                disabled={poolImages.findIndex((i) => i.id === selectedPoolImage.id) === 0}
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] hover:bg-slate-50 disabled:opacity-40"
                onClick={() => void moveImage(selectedPoolImage, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={
                  poolImages.findIndex((i) => i.id === selectedPoolImage.id) >= poolImages.length - 1
                }
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] hover:bg-slate-50 disabled:opacity-40"
                onClick={() => void moveImage(selectedPoolImage, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] hover:bg-slate-50"
                onClick={() => void renameImage(selectedPoolImage)}
              >
                命名
              </button>
              <button
                type="button"
                className="rounded-md border border-red-100 bg-white px-2.5 py-1 text-[11px] text-red-600 hover:bg-red-50"
                onClick={() => void removeImage(selectedPoolImage)}
              >
                删除
              </button>
            </div>
            </div>
          ) : null}

          {poolImages.length === 0 ? (
            <p className="text-xs text-slate-400">本池暂无图稿</p>
          ) : (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {poolImages.map((img, idx) => {
                const selected = previewUrl === img.public_url
                const label = img.name?.trim()
                return (
                  <li key={img.id}>
                    <button
                      type="button"
                      onClick={() => setPreviewUrl(img.public_url)}
                      className={`relative aspect-square w-full overflow-hidden rounded-lg border-2 transition-all ${
                        selected
                          ? 'border-brand ring-2 ring-brand/20'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                      title={draftImageDisplayName(img, idx + 1)}
                    >
                      <img src={img.public_url} alt="" className="h-full w-full object-cover" />
                      {img.is_cover ? (
                        <span className="absolute left-1 top-1 rounded bg-amber-500/90 px-1 py-0.5 text-[9px] font-medium text-white">
                          封面
                        </span>
                      ) : null}
                      {!img.include_in_publish ? (
                        <span className="absolute right-1 top-1 rounded bg-slate-900/60 px-1 py-0.5 text-[9px] text-white">
                          隐藏
                        </span>
                      ) : null}
                      {label ? (
                        <span className="absolute inset-x-0 bottom-0 truncate bg-slate-900/65 px-1 py-0.5 text-[9px] text-white">
                          {label}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <p className="mt-auto pt-4 text-[11px] text-slate-400">
            各池图稿可在「笔记管理」组合草稿时跨池勾选。
          </p>
        </section>
      </div>
      </div>
    </div>
  )
}

function UrlAddRow({
  disabled,
  onAdd,
  compact = false,
}: {
  disabled: boolean
  onAdd: (url: string) => void
  compact?: boolean
}) {
  const [url, setUrl] = useState('')
  return (
    <div className={`flex min-w-0 flex-1 gap-2 ${compact ? '' : 'mt-2 flex-wrap'}`}>
      <input
        type="url"
        disabled={disabled}
        placeholder={compact ? 'https://… URL 入池' : 'https://… 配图 URL 入池'}
        className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-2 text-sm disabled:opacity-50"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && url.trim() && !disabled) {
            onAdd(url)
            setUrl('')
          }
        }}
      />
      <button
        type="button"
        disabled={disabled || !url.trim()}
        className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
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
