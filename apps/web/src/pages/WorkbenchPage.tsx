import { Link } from 'react-router-dom'
import type { ChangeEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  apiUploadEntryImage,
  type ComposedDraftRow,
  type CopyVersion,
  type DraftImage,
  type EntryDetail,
  type EntrySummary,
  type PublishAttemptRow,
} from '../lib/api'
import {
  persistCurrentEntryId,
  resolveCurrentEntryId,
  XHS_PENDING_LOAD_COMPOSED_DRAFT,
} from '../lib/currentEntry'
import { PublishAssistantCollapsible } from '../components/PublishAssistantCollapsible'
import { confirmDeleteDraftImage } from '../lib/draftImageDelete'
import {
  dedupePublishImageUrls,
  formatBodyForXhsPublish,
  getBridgeExtensionId,
  parseTopicsInput,
  persistBridgeExtensionId,
  publishClipboardFallback,
  summarizeBridgeResponseForLog,
  topicsListsEqual,
  tryExtensionPublish,
  tryPingBridgeExtension,
} from '../lib/publishBridge'

type NoteImportOpt = {
  key: string
  label: string
  title: string
  body: string
  orderedImageIds: string[]
  coverAssetId: string | null
}

async function applyComposedDraftImageState(
  entryId: string,
  detail: EntryDetail,
  orderedRaw: string[],
  coverAssetId: string | null | undefined,
): Promise<void> {
  const images = detail.images || []
  const existingIds = new Set(images.map((i) => i.id))
  const ordered = orderedRaw.filter((id) => existingIds.has(id))
  const allIds = images.map((i) => i.id)

  if (!ordered.length) {
    await Promise.all(
      images.map((im) =>
        apiPatch(`/api/entries/${entryId}/images/${im.id}`, {
          include_in_publish: false,
          is_cover: false,
        }),
      ),
    )
    if (allIds.length) {
      await apiPut(`/api/entries/${entryId}/images/reorder`, { ids: allIds })
    }
    return
  }

  const cover =
    (coverAssetId && ordered.includes(coverAssetId) ? coverAssetId : null) ?? ordered[0] ?? null
  const tail = allIds.filter((id) => !ordered.includes(id))
  const newOrder = [...ordered, ...tail]

  await Promise.all(
    images.map((im) =>
      apiPatch(`/api/entries/${entryId}/images/${im.id}`, {
        include_in_publish: ordered.includes(im.id),
        is_cover: false,
      }),
    ),
  )
  if (cover) {
    await apiPatch(`/api/entries/${entryId}/images/${cover}`, { is_cover: true })
  }
  await apiPut(`/api/entries/${entryId}/images/reorder`, { ids: newOrder })
}

export function WorkbenchPage() {
  const [entryId, setEntryId] = useState<string | null>(null)
  const [entry, setEntry] = useState<EntryDetail | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [topicsInput, setTopicsInput] = useState('')
  const [coverUrl, setCoverUrl] = useState('')
  const [extIdInput, setExtIdInput] = useState('')
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [publishDebug, setPublishDebug] = useState<string | null>(null)
  const [showPublishDebug, setShowPublishDebug] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [newUrl, setNewUrl] = useState('')
  const [uploadingLocal, setUploadingLocal] = useState(false)
  const [previewTab, setPreviewTab] = useState<'note' | 'cover'>('note')
  const [noteImportKey, setNoteImportKey] = useState('')
  const [noteImportLoading, setNoteImportLoading] = useState(false)
  const [noteImportBusy, setNoteImportBusy] = useState(false)
  const [noteImportOptions, setNoteImportOptions] = useState<NoteImportOpt[]>([])
  /** 载入组合草稿后仅展示该草稿配图（按草稿顺序） */
  const [composedDraftImageIds, setComposedDraftImageIds] = useState<string[] | null>(null)
  const [copyVersions, setCopyVersions] = useState<CopyVersion[]>([])
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const localFileInputRef = useRef<HTMLInputElement>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2600)
  }, [])

  useEffect(() => {
    try {
      const saved = localStorage.getItem('xhs:last_publish_debug')
      if (saved && saved.trim()) setPublishDebug(saved)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    try {
      setShowPublishDebug(localStorage.getItem('xhs:show_publish_debug') === '1')
    } catch {
      setShowPublishDebug(false)
    }
  }, [])

  const persistPublishDebug = useCallback((v: string | null) => {
    setPublishDebug(v)
    try {
      if (v) localStorage.setItem('xhs:last_publish_debug', v)
      else localStorage.removeItem('xhs:last_publish_debug')
    } catch {
      /* ignore */
    }
  }, [])

  const optionalPublishClientHints = useCallback((): Record<string, unknown> | undefined => {
    const tag = import.meta.env.VITE_WEB_BUILD_TAG
    if (typeof tag === 'string' && tag.trim()) return { web_build: tag.trim() }
    return undefined
  }, [])

  const logPublishAttempt = useCallback(
    (body: {
      outcome: 'extension_success' | 'clipboard_fallback'
      extension_error?: string
      bridge_payload?: Record<string, unknown>
    }) => {
      if (!entryId) return
      const payload: Record<string, unknown> = {
        outcome: body.outcome,
        extension_error: body.extension_error ?? null,
        bridge_payload: body.bridge_payload ?? null,
      }
      const hints = optionalPublishClientHints()
      if (hints) payload.client_hints = hints
      void apiPost<PublishAttemptRow>(`/api/entries/${entryId}/publish-attempts`, payload).catch(
        () => {},
      )
    },
    [entryId, optionalPublishClientHints],
  )

  const reloadEntry = useCallback(async (id: string) => {
    const [d, vers] = await Promise.all([
      apiGet<EntryDetail>(`/api/entries/${id}`),
      apiGet<CopyVersion[]>(`/api/entries/${id}/copy-versions`),
    ])
    setEntry(d)
    setCopyVersions(vers)
    setTitle(d.title)
    setBody(d.body)
    setTopicsInput((d.topics && d.topics.length ? d.topics : []).join('\n'))
  }, [])

  const patchEntry = useCallback(
    async (nextTitle: string, nextBody: string, nextTopics: string[]) => {
      if (!entryId) return
      setSaving(true)
      try {
        const d = await apiPatch<EntryDetail>(`/api/entries/${entryId}`, {
          title: nextTitle,
          body: nextBody,
          topics: nextTopics,
        })
        setEntry(d)
        window.dispatchEvent(
          new CustomEvent('xhs:entry-updated', { detail: { entryId } }),
        )
      } catch (e) {
        showToast(e instanceof Error ? e.message : '保存失败')
      } finally {
        setSaving(false)
      }
    },
    [entryId, showToast],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoadErr(null)
        const list = await apiGet<EntrySummary[]>('/api/entries')
        if (cancelled) return
        if (!list.length) {
          setLoadErr('暂无条目，请检查 API 种子数据')
          return
        }
        const resolved = await resolveCurrentEntryId()
        const id =
          resolved && list.some((e) => e.id === resolved) ? resolved : list[0].id
        setEntryId(id)
        await reloadEntry(id)
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadEntry])

  useEffect(() => {
    if (entryId) persistCurrentEntryId(entryId)
  }, [entryId])

  useEffect(() => {
    setComposedDraftImageIds(null)
  }, [entryId])

  useEffect(() => {
    if (!entryId) return
    const onUpdated = (ev: Event) => {
      const e = ev as CustomEvent<{ entryId?: string }>
      if (e.detail?.entryId && e.detail.entryId !== entryId) return
      void reloadEntry(entryId)
    }
    window.addEventListener('xhs:entry-updated', onUpdated)
    return () => window.removeEventListener('xhs:entry-updated', onUpdated)
  }, [entryId, reloadEntry])

  useEffect(() => {
    if (!entryId) return
    let cancelled = false
    setNoteImportLoading(true)
    ;(async () => {
      try {
        const drafts = await apiGet<ComposedDraftRow[]>('/api/notes/composed-drafts')
        if (cancelled) return
        const opts: NoteImportOpt[] = []
        for (const d of drafts.filter((x) => x.entry_id === entryId)) {
          const t = (d.snapshot_title || '').trim() || '（无标题）'
          opts.push({
            key: `cmp:${d.id}`,
            label: t.slice(0, 48) + (t.length > 48 ? '…' : ''),
            title: d.snapshot_title || '',
            body: d.snapshot_body ?? '',
            orderedImageIds: (d.ordered_image_asset_ids || []).map((x) => String(x)),
            coverAssetId: d.cover_asset_id != null ? String(d.cover_asset_id) : null,
          })
        }
        setNoteImportOptions(opts)
        setNoteImportKey('')
      } catch {
        if (!cancelled) {
          setNoteImportOptions([])
          setNoteImportKey('')
        }
      } finally {
        if (!cancelled) setNoteImportLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entryId])

  useEffect(() => {
    setExtIdInput(getBridgeExtensionId(''))
  }, [])

  useEffect(() => {
    if (!entryId || !entry) return
    const topicList = parseTopicsInput(topicsInput)
    const entryTopics = entry.topics ?? []
    if (title === entry.title && body === entry.body && topicsListsEqual(topicList, entryTopics)) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void patchEntry(title, body, topicList)
    }, 800)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [title, body, topicsInput, entryId, entry, patchEntry])

  useEffect(() => {
    const onDraft = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      void patchEntry(title, body, parseTopicsInput(topicsInput))
      showToast('草稿已保存')
    }
    window.addEventListener('xhs:save-draft', onDraft)
    return () => window.removeEventListener('xhs:save-draft', onDraft)
  }, [title, body, topicsInput, patchEntry, showToast])

  const loadFromNoteImport = useCallback(async (keyOverride?: string) => {
    if (!entryId || !entry) return
    const importKey = keyOverride ?? noteImportKey
    const sel = noteImportOptions.find((o) => o.key === importKey)
    if (!sel) {
      showToast('请先选择一条组合草稿')
      return
    }
    const dirty = title !== entry.title || body !== entry.body
    setNoteImportBusy(true)
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      const topicList = parseTopicsInput(topicsInput)
      setSaving(true)
      const d = await apiPatch<EntryDetail>(`/api/entries/${entryId}`, {
        title: sel.title,
        body: sel.body,
        topics: topicList,
      })
      await applyComposedDraftImageState(
        entryId,
        d,
        sel.orderedImageIds,
        sel.coverAssetId,
      )
      const next = await apiGet<EntryDetail>(`/api/entries/${entryId}`)
      setEntry(next)
      setTitle(next.title)
      setBody(next.body)
      setComposedDraftImageIds(sel.orderedImageIds)
      window.dispatchEvent(
        new CustomEvent('xhs:entry-updated', { detail: { entryId } }),
      )
      showToast(
        dirty
          ? '已载入组合草稿：标题与正文已覆盖；仅显示并发布该草稿中的配图。'
          : '已载入组合草稿：标题、正文与配图已同步，仅显示该草稿中的图片。',
      )
    } catch (e) {
      showToast(e instanceof Error ? e.message : '载入失败')
    } finally {
      setSaving(false)
      setNoteImportBusy(false)
    }
  }, [
    entryId,
    entry,
    noteImportKey,
    noteImportOptions,
    title,
    body,
    topicsInput,
    showToast,
  ])

  useEffect(() => {
    if (!entryId || !entry || noteImportLoading || noteImportBusy) return
    let pending: string | null = null
    try {
      pending = sessionStorage.getItem(XHS_PENDING_LOAD_COMPOSED_DRAFT)
    } catch {
      return
    }
    if (!pending) return
    const key = `cmp:${pending}`
    if (!noteImportOptions.some((o) => o.key === key)) return
    try {
      sessionStorage.removeItem(XHS_PENDING_LOAD_COMPOSED_DRAFT)
    } catch {
      /* ignore */
    }
    setNoteImportKey(key)
    void loadFromNoteImport(key)
  }, [
    entryId,
    entry,
    noteImportLoading,
    noteImportBusy,
    noteImportOptions,
    loadFromNoteImport,
  ])

  const sortedImages = useMemo(() => {
    if (!entry?.images) return []
    return [...entry.images].sort((a, b) => a.sort_order - b.sort_order)
  }, [entry])

  const displayImages = useMemo(() => {
    if (composedDraftImageIds === null) return sortedImages
    const order = new Map(composedDraftImageIds.map((id, i) => [id, i]))
    return sortedImages
      .filter((im) => order.has(im.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }, [sortedImages, composedDraftImageIds])

  const poolLimit = entry?.draft_image_pool_limit ?? 18

  const copyVersionOrdinal = useCallback(
    (cvId: string | null | undefined) => {
      if (!cvId) return null
      const asc = [...copyVersions].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )
      const i = asc.findIndex((v) => v.id === cvId)
      return i >= 0 ? i + 1 : null
    },
    [copyVersions],
  )

  const publishImages = useMemo(() => {
    return sortedImages
      .filter((i) => i.include_in_publish)
      .map((i, idx) => ({
        id: i.id,
        label: `图${idx + 1} ${truncateUrl(i.public_url)}`,
        star: i.is_cover,
        url: i.public_url,
      }))
  }, [sortedImages])

  const firstPhoneVisual = useMemo(() => {
    const starred = publishImages.find((p) => p.star)
    if (starred) return { type: 'img' as const, url: starred.url }
    if (publishImages[0]) return { type: 'img' as const, url: publishImages[0].url }
    if (coverUrl.trim()) return { type: 'img' as const, url: coverUrl.trim() }
    return { type: 'placeholder' as const }
  }, [publishImages, coverUrl])

  const coverPreviewUrl = useMemo(
    () =>
      publishImages.find((p) => p.star)?.url ||
      publishImages[0]?.url ||
      (coverUrl.trim() ? coverUrl.trim() : ''),
    [publishImages, coverUrl],
  )

  const phoneBodyPreview = useMemo(() => {
    const merged = formatBodyForXhsPublish(body, parseTopicsInput(topicsInput))
    const raw = merged || ''
    return raw.slice(0, 200) + (raw.length > 200 ? '…' : '')
  }, [body, topicsInput])

  const handlePublish = () => {
    if (!confirmPublish) return
    const extId = getBridgeExtensionId(extIdInput)
    const topicList = parseTopicsInput(topicsInput)
    const publishBody = formatBodyForXhsPublish(body, topicList)
    const imageUrls = dedupePublishImageUrls(
      [...publishImages]
        .sort((a, b) => Number(b.star) - Number(a.star))
        .map((p) => p.url),
    )
    const firstImageUrl = imageUrls[0]
    tryExtensionPublish(extId, title, publishBody, (r) => {
      if (r.ok) {
        logPublishAttempt({
          outcome: 'extension_success',
          bridge_payload: summarizeBridgeResponseForLog(r.response),
        })
        const resp = r.response as any
        const filled = resp?.result?.filled
        const imageOk = Boolean(filled?.image_upload)
        const wroteTitle = Boolean(filled?.title)
        const wroteBody = Boolean(filled?.body)
        const detail = typeof resp?.result?.detail === 'string' ? String(resp.result.detail) : ''
        const topicHint = parseTopicsInput(topicsInput).length ? '（含 # 话题）' : ''
        persistPublishDebug(
          JSON.stringify(
            {
              ok: true,
              filled: filled || null,
              detail: detail || null,
              tabId: typeof resp?.tabId === 'number' ? resp.tabId : null,
              imageUrlCount: imageUrls.length,
              imageUrls,
              at: new Date().toISOString(),
            },
            null,
            2,
          ),
        )
        if (!imageOk) {
          showToast(
            `发布助手已打开创作页并尝试写入标题/正文${topicHint}；但图片未自动触发上传（${detail || '请在创作页点「上传图片」'}）。`,
          )
        } else if (!wroteTitle && !wroteBody) {
          showToast(
            `发布助手已打开创作页，但未找到标题或正文输入框（${detail || '创作页布局可能已更新，请稍后再试或联系管理员'}）。`,
          )
        } else {
          showToast(
            topicHint
              ? '发布助手已打开创作页并尝试填入标题与正文（含 # 话题；发布仍须在小红书侧自行确认）。'
              : '发布助手已打开创作页并尝试填入标题/正文（无法代你点小红书「发布」，请在创作页核对后自行发布）。',
          )
        }
        return
      }
      const hint = r.reason.length > 120 ? `${r.reason.slice(0, 120)}…` : r.reason
      persistPublishDebug(
        JSON.stringify(
          { ok: false, reason: r.reason, response: (r as any).response ?? null, at: new Date().toISOString() },
          null,
          2,
        ),
      )
      showToast(`发布助手未接通：${hint}。将打开创作页并尝试复制到剪贴板。`)
      logPublishAttempt({
        outcome: 'clipboard_fallback',
        extension_error: r.reason,
      })
      publishClipboardFallback(
        title,
        body,
        publishImages.map(({ label, star }) => ({ label, star })),
        showToast,
        topicList,
      )
    }, { firstImageUrl, imageUrls })
  }

  const saveExtId = () => {
    persistBridgeExtensionId(extIdInput)
    showToast('发布助手编号已保存')
  }

  const handlePingExtension = () => {
    const extId = getBridgeExtensionId(extIdInput)
    tryPingBridgeExtension(extId, (r) => {
      if (r.ok) {
        showToast(`发布助手已连接（版本 ${r.version}）。`)
      } else {
        const hint = r.reason.length > 100 ? `${r.reason.slice(0, 100)}…` : r.reason
        showToast(`发布助手未连接：${hint}`)
      }
    })
  }

  const addImage = async () => {
    if (!entryId || !newUrl.trim()) return
    if (sortedImages.length >= poolLimit) {
      showToast(`图稿池已满（${poolLimit} 张）`)
      return
    }
    const primaryId = copyVersions.find((v) => v.is_primary)?.id ?? copyVersions[0]?.id
    try {
      await apiPost<DraftImage>(`/api/entries/${entryId}/images`, {
        public_url: newUrl.trim(),
        include_in_publish: true,
        ...(primaryId ? { source_copy_version_id: primaryId } : {}),
      })
      setNewUrl('')
      setComposedDraftImageIds(null)
      await reloadEntry(entryId)
      window.dispatchEvent(new CustomEvent('xhs:entry-updated', { detail: { entryId } }))
      showToast('已添加配图')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '添加失败')
    }
  }

  const onLocalFilesChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!entryId || !files?.length) return
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (!arr.length) {
      showToast('请选择图片文件')
      e.target.value = ''
      return
    }
    const room = poolLimit - sortedImages.length
    if (room <= 0) {
      showToast(`图稿池已满（${poolLimit} 张）`)
      e.target.value = ''
      return
    }
    const batch = arr.slice(0, room)
    if (batch.length < arr.length) {
      showToast(`仅余 ${room} 个空位，已截取前 ${room} 张`)
    }
    const primaryId = copyVersions.find((v) => v.is_primary)?.id ?? copyVersions[0]?.id
    setUploadingLocal(true)
    try {
      let n = 0
      for (const f of batch) {
        await apiUploadEntryImage(entryId, f, { sourceCopyVersionId: primaryId ?? undefined })
        n += 1
      }
      if (n) {
        setComposedDraftImageIds(null)
        await reloadEntry(entryId)
        window.dispatchEvent(new CustomEvent('xhs:entry-updated', { detail: { entryId } }))
        showToast(`已上传 ${n} 张本地图片`)
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploadingLocal(false)
      e.target.value = ''
    }
  }

  const toggleInclude = async (img: DraftImage) => {
    if (!entryId) return
    try {
      await apiPatch<DraftImage>(`/api/entries/${entryId}/images/${img.id}`, {
        include_in_publish: !img.include_in_publish,
      })
      await reloadEntry(entryId)
      window.dispatchEvent(new CustomEvent('xhs:entry-updated', { detail: { entryId } }))
    } catch (e) {
      showToast(e instanceof Error ? e.message : '更新失败')
    }
  }

  const setCover = async (img: DraftImage) => {
    if (!entryId) return
    try {
      await apiPatch<DraftImage>(`/api/entries/${entryId}/images/${img.id}`, {
        is_cover: true,
      })
      await reloadEntry(entryId)
      window.dispatchEvent(new CustomEvent('xhs:entry-updated', { detail: { entryId } }))
    } catch (e) {
      showToast(e instanceof Error ? e.message : '更新失败')
    }
  }

  const removeImage = async (img: DraftImage) => {
    if (!entryId) return
    if (!(await confirmDeleteDraftImage(img))) return
    try {
      await apiDelete(`/api/entries/${entryId}/images/${img.id}`)
      await reloadEntry(entryId)
      window.dispatchEvent(new CustomEvent('xhs:entry-updated', { detail: { entryId } }))
      showToast('已移除')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  if (loadErr) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-red-100 bg-white p-8 text-slate-800 shadow-sm">
        <p className="font-medium text-red-600">加载失败</p>
        <p className="mt-2 text-sm text-slate-600">{loadErr}</p>
        <p className="mt-4 text-sm text-slate-500">
          请确认服务已启动且网络正常；若页面提示未登录或无权访问，请先完成登录与权限配置。
        </p>
      </div>
    )
  }

  if (!entry || !entryId) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-slate-500">加载工作台…</div>
    )
  }

  return (
    <div className="relative mx-auto max-w-[1280px] text-slate-900">
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      <p className="mb-4 text-xs text-slate-500">
        内容会随编辑自动保存。
        {saving ? <span className="ml-2 text-brand">· 保存中…</span> : null}
      </p>

      <div className="grid items-start gap-6 xl:grid-cols-[1fr_320px]">
        {/* 左：图文编辑卡片 */}
        <div className="flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex shrink-0 items-center border-b border-slate-100 px-5 py-3">
            <span className="text-sm font-semibold text-slate-900">图文编辑</span>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {/* 从笔记管理载入（占位，对齐原型） */}
            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/90 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                <div className="min-w-0 flex-1 sm:min-w-[220px]">
                  <label className="mb-1 block text-xs text-slate-500">
                    载入组合草稿（笔记管理中「组合生成」）
                  </label>
                  <select
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 disabled:opacity-60"
                    disabled={noteImportLoading || noteImportBusy}
                    value={noteImportKey}
                    onChange={(e) => setNoteImportKey(e.target.value)}
                  >
                    <option value="">
                      {noteImportLoading
                        ? '加载草稿列表…'
                        : noteImportOptions.length
                          ? '— 请选择组合草稿 —'
                          : '— 当前条目暂无组合草稿 —'}
                    </option>
                    {noteImportOptions.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    disabled={!noteImportKey || noteImportLoading || noteImportBusy}
                    onClick={() => void loadFromNoteImport()}
                  >
                    {noteImportBusy ? '载入中…' : '载入到编辑区'}
                  </button>
                  <Link to="/notes" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">
                    去笔记管理
                  </Link>
                </div>
              </div>
              <p className="text-xs text-slate-400">
                载入后工作台仅显示该草稿中的配图；其余图稿仍在「图片管理」图稿池中。文案版本与已发布历史不会直接写入工作台。
              </p>
            </div>

            {/* 图片条 */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-800">图片编辑</span>
                <span className="text-xs text-slate-500">
                  {displayImages.length}/{poolLimit} ·{' '}
                  {composedDraftImageIds !== null ? '草稿配图' : '参与发布'}
                </span>
              </div>
              {composedDraftImageIds !== null ? (
                <button
                  type="button"
                  className="mb-2 text-xs font-medium text-brand hover:underline"
                  onClick={() => setComposedDraftImageIds(null)}
                >
                  显示全部图稿池
                </button>
              ) : null}
              <div className="flex min-h-[5.5rem] flex-wrap items-center gap-2">
                {displayImages.map((img) => (
                  <div key={img.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => void setCover(img)}
                      className={`relative h-20 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-slate-100 ${
                        img.is_cover ? 'border-brand ring-1 ring-brand/30' : 'border-slate-200'
                      } ${img.include_in_publish ? '' : 'opacity-40'}`}
                    >
                      <img src={img.public_url} alt="" className="h-full w-full object-cover" />
                      {img.is_cover && (
                        <span className="absolute bottom-0.5 left-0.5 rounded bg-amber-400 px-0.5 text-[9px] text-amber-950">
                          封
                        </span>
                      )}
                      {copyVersionOrdinal(img.source_copy_version_id) != null && (
                        <span className="absolute left-0.5 top-0.5 rounded bg-slate-900/80 px-0.5 text-[8px] text-white">
                          v{copyVersionOrdinal(img.source_copy_version_id)}
                        </span>
                      )}
                    </button>
                    <div className="absolute -right-1 -top-1 flex gap-0.5 opacity-0 transition group-hover:opacity-100">
                      <button
                        type="button"
                        className="rounded bg-white/95 px-1 text-[10px] shadow border border-slate-200"
                        onClick={() => void toggleInclude(img)}
                        title="参与发布"
                      >
                        {img.include_in_publish ? '✓' : '+'}
                      </button>
                      <button
                        type="button"
                        className="rounded bg-white/95 px-1 text-[10px] text-red-600 shadow border border-slate-200"
                        onClick={() => void removeImage(img)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
                {displayImages.length === 0 && (
                  <span className="text-xs text-slate-400">
                    {composedDraftImageIds !== null
                      ? '该草稿暂无配图，可在「图片管理」维护后重新载入'
                      : '可选本地图片上传，或填写下方 HTTPS 图片地址，或去「图片管理」维护图稿池'}
                  </span>
                )}
              </div>
              <input
                ref={localFileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                className="hidden"
                onChange={(e) => void onLocalFilesChange(e)}
              />
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <button
                  type="button"
                  disabled={uploadingLocal}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  onClick={() => localFileInputRef.current?.click()}
                >
                  {uploadingLocal ? '上传中…' : '选择本地图片'}
                </button>
                <input
                  type="url"
                  className="min-w-[10rem] flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  placeholder="https://… 配图 URL"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                />
                <button
                  type="button"
                  className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-dark"
                  onClick={() => void addImage()}
                >
                  添加 URL
                </button>
                <Link to="/images" className="text-xs font-medium text-brand hover:underline">
                  去「图片管理」生图
                </Link>
              </div>
            </div>

            {/* 封面 URL */}
            <div>
              <label className="mb-1 block text-xs text-slate-500">封面图 URL（可选）</label>
              <input
                type="url"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                placeholder="https://…"
                value={coverUrl}
                onChange={(e) => setCoverUrl(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-400">
                有「参与发布」图稿时：首图/封面预览以<strong>标星图稿</strong>为准，URL 仅作运营备忘；无图稿时可用 URL 做首图预览占位。
              </p>
            </div>

            {/* 标题正文 */}
            <div>
              <div className="mb-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600"
                  disabled
                >
                  智能标题
                </button>
                <span className="self-center text-xs text-slate-400">{body.length}/1000</span>
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
                rows={10}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-relaxed"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <label className="mb-1 mt-3 block text-xs text-slate-500">
                话题（发布到小红书时自动以 <code className="text-[0.65rem]">#话题</code> 追加到正文末尾；每行一个或逗号分隔，无需自己写 #）
              </label>
              <textarea
                rows={3}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-relaxed"
                placeholder={'例如：有趣的可视化\n搞错了再来'}
                value={topicsInput}
                onChange={(e) => setTopicsInput(e.target.value)}
              />
              <p className="mt-1 text-[0.65rem] text-slate-400">
                正文框内保持纯文案即可；与创作页「正文中含 #」展示一致，最多约 35 个话题。
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                <span className="rounded border border-slate-200 px-2 py-1 text-slate-400">@用户（未接）</span>
                <span className="rounded border border-slate-200 px-2 py-1 text-slate-400">表情（未接）</span>
              </div>
              <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
                <div className="mb-1 text-xs font-medium text-slate-600">活动话题</div>
                <label className="text-xs text-slate-600">
                  <input type="checkbox" className="mr-1 rounded border-slate-300" disabled /> #RED新生代创作大赛（示意）
                </label>
              </div>
            </div>

            {/* 内容设置 */}
            <div className="space-y-3 border-t border-slate-100 pt-4">
              <div className="text-sm font-medium text-slate-800">内容设置</div>
              <div className="flex flex-wrap gap-4 text-xs">
                <label className="flex items-center gap-1 text-slate-600">
                  <input type="checkbox" className="rounded border-slate-300" disabled /> 加入合集（数学提分系列）
                </label>
                <label className="flex items-center gap-1 text-slate-600">
                  <input type="checkbox" className="rounded border-slate-300" disabled /> 原创声明
                </label>
              </div>
              <div>
                <span className="text-xs text-slate-500">笔记含 AI 合成内容</span>
                <select className="ml-2 rounded border border-slate-200 px-2 py-1 text-xs" disabled defaultValue="ai">
                  <option value="ai">含 AI 生成图片</option>
                  <option value="no">不含</option>
                </select>
              </div>
            </div>

            {/* 添加组件 */}
            <div className="space-y-2 border-t border-slate-100 pt-4">
              <div className="text-sm font-medium text-slate-800">添加组件</div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-lg bg-slate-100 px-2 py-1">位置 · 南开区</span>
                <span className="rounded-lg bg-slate-100 px-2 py-1">分类 · 初中教育</span>
                <button
                  type="button"
                  className="rounded-lg border border-dashed border-slate-300 px-2 py-1 text-slate-500"
                  disabled
                >
                  + 选择文件
                </button>
              </div>
            </div>
          </div>

          {/* 底部发布栏 */}
          <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-5 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-600 sm:max-w-[55%]">
                <input
                  type="checkbox"
                  checked={confirmPublish}
                  onChange={(e) => setConfirmPublish(e.target.checked)}
                  className="mt-0.5 shrink-0 rounded border-slate-300"
                />
                <span>已核对文案、参与发布图稿与右侧手机预览一致</span>
              </label>
              <button
                type="button"
                disabled={!confirmPublish}
                onClick={handlePublish}
                className="w-full shrink-0 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto whitespace-nowrap"
              >
                发布到小红书
              </button>
            </div>
            <p className="mt-2 text-[0.7rem] leading-relaxed text-slate-400">
              若已填写下方<strong>发布助手编号</strong>并已安装助手：将尝试在创作页直接填入标题与正文，并上传左侧标记为「参与发布」的{' '}
              <strong>{publishImages.length}</strong> 张图（最多 9 张）；否则会打开创作页并把标题、正文与配图清单写入
              <strong>剪贴板</strong>。
            </p>
            {showPublishDebug ? (
              <details className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[0.7rem] text-slate-600">
                <summary className="cursor-pointer select-none font-medium text-slate-700">
                  发布调试信息（复制给开发排查）
                </summary>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded border border-slate-200 bg-white px-2 py-1 text-[0.65rem] text-slate-700 hover:bg-slate-50"
                    onClick={() => {
                      if (!publishDebug) return
                      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(publishDebug)
                      showToast('已复制发布调试信息')
                    }}
                    disabled={!publishDebug}
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-200 bg-white px-2 py-1 text-[0.65rem] text-slate-700 hover:bg-slate-50"
                    onClick={() => persistPublishDebug(null)}
                  >
                    清空
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-200 bg-white px-2 py-1 text-[0.65rem] text-slate-700 hover:bg-slate-50"
                    onClick={() => {
                      try {
                        localStorage.removeItem('xhs:show_publish_debug')
                      } catch {
                        /* ignore */
                      }
                      setShowPublishDebug(false)
                    }}
                  >
                    隐藏
                  </button>
                  <span className="text-[0.65rem] text-slate-400">
                    提示：点击「发布到小红书」后会自动更新此处
                  </span>
                </div>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.65rem] text-slate-600">
                  {publishDebug || '（暂无）'}
                </pre>
              </details>
            ) : null}
            <PublishAssistantCollapsible
              className="mt-3"
              hint="创作页控制台里偶发的助手相关报错，多数来自小红书站点自身，不必紧张；是否连通请以「检测发布助手」或点击发布后的提示为准。"
            >
              <label htmlFor="xhs-bridge-ext-id" className="mb-1 block text-xs text-slate-500">
                发布助手编号（可选，用于自动填入创作页）
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="xhs-bridge-ext-id"
                  type="text"
                  autoComplete="off"
                  placeholder="在浏览器扩展管理页复制助手编号"
                  className="min-w-[12rem] flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs"
                  value={extIdInput}
                  onChange={(e) => setExtIdInput(e.target.value)}
                />
                <button
                  type="button"
                  onClick={saveExtId}
                  className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs hover:bg-slate-100"
                >
                  保存到本页
                </button>
                <button
                  type="button"
                  onClick={handlePingExtension}
                  className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs hover:bg-slate-100"
                >
                  检测发布助手
                </button>
              </div>
            </PublishAssistantCollapsible>
          </div>
        </div>

        {/* 右：预览 sticky */}
        <div className="space-y-3 xl:sticky xl:top-20">
          <div className="flex rounded-lg border border-slate-200 bg-white p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => setPreviewTab('note')}
              className={`flex-1 rounded-md py-2 ${previewTab === 'note' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              笔记预览
            </button>
            <button
              type="button"
              onClick={() => setPreviewTab('cover')}
              className={`flex-1 rounded-md py-2 ${previewTab === 'cover' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              封面预览
            </button>
          </div>

          <div className="mx-auto w-[280px] overflow-hidden rounded-[2rem] border-8 border-slate-900 bg-slate-900 shadow-xl">
            <div className="flex min-h-[520px] flex-col rounded-b-3xl bg-white">
              <div className="h-7 shrink-0 bg-slate-900" />
              {previewTab === 'note' ? (
                <div className="flex flex-1 flex-col overflow-hidden p-3">
                  <div className="mb-2 overflow-hidden rounded-xl">
                    {firstPhoneVisual.type === 'img' ? (
                      <div className="relative aspect-[3/4]">
                        <img src={firstPhoneVisual.url} alt="" className="h-full w-full object-cover" />
                      </div>
                    ) : (
                      <div className="flex aspect-[3/4] items-end justify-center bg-gradient-to-b from-rose-100 to-sky-50 pb-4 text-xs text-slate-500">
                        首图预览
                      </div>
                    )}
                  </div>
                  <p className="text-sm font-semibold leading-snug text-slate-900">{title || '标题'}</p>
                  <p className="mt-2 line-clamp-6 whitespace-pre-line text-xs text-slate-600">{phoneBodyPreview || '正文预览与左侧同步…'}</p>
                </div>
              ) : (
                <div className="flex min-h-[480px] flex-col items-center justify-center p-4">
                  {coverPreviewUrl ? (
                    <div className="aspect-square w-full overflow-hidden rounded-xl border border-slate-200">
                      <img src={coverPreviewUrl} alt="" className="h-full w-full object-cover" />
                    </div>
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center rounded-xl border border-slate-200 bg-gradient-to-br from-rose-100 to-sky-100 text-sm text-slate-500">
                      封面安全区
                    </div>
                  )}
                  <p className="mt-3 text-center text-xs text-slate-400">优先标星图稿；无图稿时见本页封面 URL 规则</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function truncateUrl(s: string, max = 48): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}
