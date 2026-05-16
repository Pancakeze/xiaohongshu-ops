import type { ChangeEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  type ComposedDraftDetail,
  type ComposedDraftRow,
  type CopyVersion,
  type DraftFolderTree,
  type DraftImage,
  type EntryDetail,
  type EntrySummary,
  type PublishedNote,
  type SyncNotesResponse,
} from '../lib/api'
import {
  persistCurrentEntryId,
  resolveCurrentEntryId,
  scheduleWorkbenchLoadComposedDraft,
} from '../lib/currentEntry'
import { formatYmdHm } from '../lib/formatDate'

type NotesTab = 'hist' | 'draft'
/** all=全部；uncategorized=未分类；否则为二级目录 id */
type FolderFilter = 'all' | 'uncategorized' | string

function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('zh-CN')
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n}%`
}

function fmtSigned(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n > 0) return `+${n.toLocaleString('zh-CN')}`
  return n.toLocaleString('zh-CN')
}

function draftStatusLabel(status: string): string {
  if (status === 'images_ready') return '图文齐全'
  return '待配图'
}

function formatCvLabel(v: CopyVersion): string {
  const t = v.title.trim() || '（空标题）'
  const time = formatYmdHm(v.created_at)
  const tag = v.source === 'manual' ? '人工' : '生成'
  return `${t.slice(0, 24)}${t.length > 24 ? '…' : ''} · ${tag} · ${time}`
}

function defaultPickedFromPool(images: DraftImage[] | undefined): Set<string> {
  return new Set((images ?? []).filter((im) => im.include_in_publish).map((im) => im.id))
}

function folderIdsForL2(
  folders: DraftFolderTree[],
  l2Id: string | null,
): { l1: string; l2: string } {
  if (!l2Id) return { l1: '', l2: '' }
  for (const l1 of folders) {
    if (l1.children.some((c) => c.id === l2Id)) return { l1: l1.id, l2: l2Id }
  }
  return { l1: '', l2: '' }
}

export function NotesPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<NotesTab>('hist')
  const [published, setPublished] = useState<PublishedNote[]>([])
  const [drafts, setDrafts] = useState<ComposedDraftRow[]>([])
  const [folders, setFolders] = useState<DraftFolderTree[]>([])
  const [folderFilter, setFolderFilter] = useState<FolderFilter>('all')
  const [expandedL1, setExpandedL1] = useState<Set<string>>(() => new Set())
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  const [composeOpen, setComposeOpen] = useState(false)
  const [composeEntryId, setComposeEntryId] = useState<string | null>(null)
  const [composeDetail, setComposeDetail] = useState<EntryDetail | null>(null)
  const [copyVersions, setCopyVersions] = useState<CopyVersion[]>([])
  const [cvId, setCvId] = useState<string | null>(null)
  const [pickedImages, setPickedImages] = useState<Set<string>>(() => new Set())
  const [composeBusy, setComposeBusy] = useState(false)
  const [composeFolderL1, setComposeFolderL1] = useState<string>('')
  const [composeFolderL2, setComposeFolderL2] = useState<string>('')

  const [previewDetail, setPreviewDetail] = useState<ComposedDraftDetail | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [editDraft, setEditDraft] = useState<ComposedDraftRow | null>(null)
  const [editDetail, setEditDetail] = useState<EntryDetail | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const [editPickedImages, setEditPickedImages] = useState<Set<string>>(() => new Set())
  const [editFolderL1, setEditFolderL1] = useState('')
  const [editFolderL2, setEditFolderL2] = useState('')
  const [editBusy, setEditBusy] = useState(false)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2800)
  }, [])

  const refreshPublished = useCallback(async () => {
    const rows = await apiGet<PublishedNote[]>('/api/notes/published')
    setPublished(rows)
  }, [])

  const refreshDrafts = useCallback(async () => {
    const rows = await apiGet<ComposedDraftRow[]>('/api/notes/composed-drafts')
    setDrafts(rows)
  }, [])

  const refreshFolders = useCallback(async () => {
    const tree = await apiGet<DraftFolderTree[]>('/api/notes/draft-folders')
    setFolders(tree)
    setExpandedL1((prev) => {
      const next = new Set(prev)
      for (const f of tree) next.add(f.id)
      return next
    })
  }, [])

  const loadAll = useCallback(async () => {
    try {
      setLoadErr(null)
      const [pub, dr, tree] = await Promise.all([
        apiGet<PublishedNote[]>('/api/notes/published'),
        apiGet<ComposedDraftRow[]>('/api/notes/composed-drafts'),
        apiGet<DraftFolderTree[]>('/api/notes/draft-folders'),
      ])
      setPublished(pub)
      setDrafts(dr)
      setFolders(tree)
      setExpandedL1(new Set(tree.map((f) => f.id)))
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const openCompose = async () => {
    try {
      let eid = await resolveCurrentEntryId()
      if (!eid) {
        showToast('暂无内容条目，请先在工作台创建或加载条目')
        return
      }
      const entList = await apiGet<EntrySummary[]>('/api/entries')
      if (!entList.some((e) => e.id === eid)) {
        eid = entList[0]?.id ?? null
      }
      if (!eid) {
        showToast('暂无内容条目，请先在工作台创建或加载条目')
        return
      }
      persistCurrentEntryId(eid)
      setComposeEntryId(eid)
      setComposeOpen(true)
      setComposeFolderL1('')
      setComposeFolderL2('')
      setComposeBusy(true)
      const [detail, cvs] = await Promise.all([
        apiGet<EntryDetail>(`/api/entries/${eid}`),
        apiGet<CopyVersion[]>(`/api/entries/${eid}/copy-versions`),
      ])
      setComposeDetail(detail)
      setCopyVersions(cvs)
      const primary = cvs.find((c) => c.is_primary)
      const initialCv = (primary ?? cvs[0])?.id ?? null
      setCvId(initialCv)
      setPickedImages(defaultPickedFromPool(detail.images))
      setComposeBusy(false)
    } catch (e) {
      setComposeBusy(false)
      showToast(e instanceof Error ? e.message : '加载失败')
    }
  }

  const togglePickImage = (id: string) => {
    setPickedImages((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const composePoolImages = useMemo(() => {
    if (!composeDetail?.images) return []
    return [...composeDetail.images].sort((a, b) => a.sort_order - b.sort_order)
  }, [composeDetail])

  const orderedSelectedIds = useMemo(() => {
    return composePoolImages.filter((im) => pickedImages.has(im.id)).map((im) => im.id)
  }, [composePoolImages, pickedImages])

  const coverAssetId = useMemo(() => {
    const selected = composePoolImages.filter((im) => pickedImages.has(im.id))
    const starred = selected.find((im) => im.is_cover)
    return starred?.id ?? selected[0]?.id ?? null
  }, [composePoolImages, pickedImages])

  const composeL2Options = useMemo(() => {
    if (!composeFolderL1) return []
    return folders.find((f) => f.id === composeFolderL1)?.children ?? []
  }, [folders, composeFolderL1])

  const visibleDrafts = useMemo(() => {
    if (folderFilter === 'all') return drafts
    if (folderFilter === 'uncategorized') return drafts.filter((d) => !d.folder_id)
    return drafts.filter((d) => d.folder_id === folderFilter)
  }, [drafts, folderFilter])

  const allL2Folders = useMemo(
    () => folders.flatMap((l1) => l1.children.map((c) => ({ ...c, l1Name: l1.name }))),
    [folders],
  )

  const toggleL1Expand = (id: string) => {
    setExpandedL1((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const promptName = (title: string, defaultValue = '') => {
    const v = window.prompt(title, defaultValue)
    return v?.trim() || null
  }

  const addFolderL1 = async () => {
    const name = promptName('一级分类名称（如：数学）')
    if (!name) return
    try {
      await apiPost('/api/notes/draft-folders', { name })
      await refreshFolders()
      showToast('已添加一级分类')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '添加失败')
    }
  }

  const addFolderL2 = async (parentId: string) => {
    const name = promptName('二级分类名称（如：2026年）')
    if (!name) return
    try {
      await apiPost('/api/notes/draft-folders', { name, parent_id: parentId })
      await refreshFolders()
      showToast('已添加二级分类')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '添加失败')
    }
  }

  const renameFolder = async (id: string, current: string) => {
    const name = promptName('重命名分类', current)
    if (!name || name === current) return
    try {
      await apiPatch(`/api/notes/draft-folders/${id}`, { name })
      await refreshFolders()
      showToast('已重命名')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '重命名失败')
    }
  }

  const removeFolder = async (id: string, isL1: boolean) => {
    const msg = isL1
      ? '删除一级分类前请先删除其下所有二级分类。确定删除？'
      : '删除后，该目录下草稿将变为「未分类」。确定删除？'
    if (!window.confirm(msg)) return
    try {
      await apiDelete(`/api/notes/draft-folders/${id}`)
      if (folderFilter === id) setFolderFilter('all')
      await Promise.all([refreshFolders(), refreshDrafts()])
      showToast('已删除分类')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  const moveDraftFolder = async (draftId: string, folderId: string | null) => {
    try {
      await apiPatch<ComposedDraftRow>(`/api/notes/composed-drafts/${draftId}`, {
        folder_id: folderId,
      })
      await refreshDrafts()
      showToast(folderId ? '已移动草稿' : '已设为未分类')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '移动失败')
    }
  }

  const openPreview = async (draftId: string) => {
    setPreviewDetail(null)
    setPreviewBusy(true)
    try {
      const d = await apiGet<ComposedDraftDetail>(`/api/notes/composed-drafts/${draftId}`)
      setPreviewDetail(d)
    } catch (e) {
      showToast(e instanceof Error ? e.message : '预览加载失败')
    } finally {
      setPreviewBusy(false)
    }
  }

  const openEdit = async (d: ComposedDraftRow) => {
    const { l1, l2 } = folderIdsForL2(folders, d.folder_id ?? null)
    setEditDraft(d)
    setEditTitle(d.snapshot_title || '')
    setEditBody(d.snapshot_body ?? '')
    setEditFolderL1(l1)
    setEditFolderL2(l2)
    setEditDetail(null)
    setEditPickedImages(new Set())
    setEditBusy(true)
    try {
      const detail = await apiGet<EntryDetail>(`/api/entries/${d.entry_id}`)
      setEditDetail(detail)
      const poolIds = new Set((detail.images ?? []).map((im) => im.id))
      setEditPickedImages(
        new Set((d.ordered_image_asset_ids || []).filter((id) => poolIds.has(id))),
      )
    } catch (e) {
      setEditDraft(null)
      showToast(e instanceof Error ? e.message : '加载失败')
    } finally {
      setEditBusy(false)
    }
  }

  const toggleEditPickImage = (id: string) => {
    setEditPickedImages((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const editPoolImages = useMemo(() => {
    if (!editDetail?.images) return []
    return [...editDetail.images].sort((a, b) => a.sort_order - b.sort_order)
  }, [editDetail])

  const editOrderedIds = useMemo(
    () => editPoolImages.filter((im) => editPickedImages.has(im.id)).map((im) => im.id),
    [editPoolImages, editPickedImages],
  )

  const editCoverAssetId = useMemo(() => {
    const selected = editPoolImages.filter((im) => editPickedImages.has(im.id))
    const starred = selected.find((im) => im.is_cover)
    return starred?.id ?? selected[0]?.id ?? null
  }, [editPoolImages, editPickedImages])

  const editL2Options = useMemo(() => {
    if (!editFolderL1) return []
    return folders.find((f) => f.id === editFolderL1)?.children ?? []
  }, [folders, editFolderL1])

  const saveEdit = async () => {
    if (!editDraft) return
    setEditBusy(true)
    try {
      await apiPatch<ComposedDraftRow>(`/api/notes/composed-drafts/${editDraft.id}`, {
        snapshot_title: editTitle.trim(),
        snapshot_body: editBody,
        ordered_image_asset_ids: editOrderedIds,
        cover_asset_id: editCoverAssetId,
        folder_id: editFolderL2 || null,
      })
      setEditDraft(null)
      setEditDetail(null)
      await refreshDrafts()
      showToast('草稿已更新')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '保存失败')
    } finally {
      setEditBusy(false)
    }
  }

  const deleteDraft = async (d: ComposedDraftRow) => {
    const label = (d.snapshot_title || '').trim() || '（无标题）'
    if (!window.confirm(`确定删除草稿「${label.slice(0, 40)}」？此操作不可恢复。`)) return
    try {
      await apiDelete(`/api/notes/composed-drafts/${d.id}`)
      if (previewDetail?.id === d.id) setPreviewDetail(null)
      if (editDraft?.id === d.id) {
        setEditDraft(null)
        setEditDetail(null)
      }
      await refreshDrafts()
      showToast('已删除草稿')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  const openWorkbench = (d: ComposedDraftRow) => {
    persistCurrentEntryId(d.entry_id)
    scheduleWorkbenchLoadComposedDraft(d.id)
    navigate('/workbench')
  }

  const confirmCompose = async () => {
    if (!composeEntryId || !cvId) {
      showToast('请选择文案版本')
      return
    }
    setComposeBusy(true)
    try {
      await apiPost<ComposedDraftRow>('/api/notes/composed-drafts', {
        entry_id: composeEntryId,
        snapshot_copy_version_id: cvId,
        ordered_image_asset_ids: orderedSelectedIds,
        cover_asset_id: coverAssetId,
        folder_id: composeFolderL2 || null,
      })
      showToast('已生成草稿并加入笔记管理')
      setComposeOpen(false)
      await refreshDrafts()
      setTab('draft')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '生成失败')
    } finally {
      setComposeBusy(false)
    }
  }

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      showToast('JSON 解析失败')
      return
    }
    let items: unknown[]
    if (Array.isArray(parsed)) {
      items = parsed
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      'items' in parsed &&
      Array.isArray((parsed as { items: unknown }).items)
    ) {
      items = (parsed as { items: Record<string, unknown>[] }).items
    } else {
      showToast('文件格式：数组，或 { "items": [ … ] }')
      return
    }
    const normalized = items
      .map((row) => {
        if (!row || typeof row !== 'object') return null
        const o = row as Record<string, unknown>
        const title = typeof o.title === 'string' ? o.title.trim() : ''
        if (!title) return null
        return {
          title,
          body: typeof o.body === 'string' ? o.body : '',
          official_url: typeof o.official_url === 'string' ? o.official_url : undefined,
          views: typeof o.views === 'number' ? o.views : undefined,
          click_rate_pct: typeof o.click_rate_pct === 'number' ? o.click_rate_pct : undefined,
          watch_count: typeof o.watch_count === 'number' ? o.watch_count : undefined,
          likes: typeof o.likes === 'number' ? o.likes : undefined,
          favorites: typeof o.favorites === 'number' ? o.favorites : undefined,
          comments: typeof o.comments === 'number' ? o.comments : undefined,
          follower_gain: typeof o.follower_gain === 'number' ? o.follower_gain : undefined,
          metrics_pending: o.metrics_pending === true,
        }
      })
      .filter(Boolean) as Record<string, unknown>[]
    if (!normalized.length) {
      showToast('没有有效的笔记记录（每条需含 title）')
      return
    }
    try {
      const res = await apiPost<SyncNotesResponse>('/api/notes/published/import', { items: normalized })
      showToast(res.message)
      await refreshPublished()
      setTab('hist')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导入失败')
    }
  }

  return (
    <div className="mx-auto max-w-[1100px]" data-feature="notes">
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => void onImportFile(e)}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          id="btn-sync-xhs"
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          onClick={() => importInputRef.current?.click()}
        >
          同步小红书历史笔记
        </button>
        <button
          type="button"
          id="btn-open-compose"
          className="rounded-lg border border-brand px-4 py-2 text-sm font-medium text-brand hover:bg-brand-soft"
          onClick={() => void openCompose()}
        >
          组合生成新笔记
        </button>
        <span className="text-xs text-slate-500">
          数据须来自<strong className="font-medium text-slate-600">官方开放接口 / 授权导出 / 手动导入</strong>
          （示意）
        </span>
      </div>

      <div className="mb-4 flex gap-2 text-sm">
        <button
          type="button"
          className={`rounded-lg px-3 py-1.5 ${tab === 'hist' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          onClick={() => setTab('hist')}
        >
          已发布历史
        </button>
        <button
          type="button"
          className={`rounded-lg px-3 py-1.5 ${tab === 'draft' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          onClick={() => setTab('draft')}
        >
          草稿 / 组合生成
        </button>
      </div>

      {loadErr ? (
        <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{loadErr}</p>
      ) : null}

      {tab === 'hist' ? (
        <div id="notes-panel-hist" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-[920px] w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <th className="px-2 py-2">笔记标题</th>
                  <th className="px-2 py-2">链接</th>
                  <th className="px-2 py-2">浏览量</th>
                  <th className="px-2 py-2">点击率</th>
                  <th className="px-2 py-2">观看量</th>
                  <th className="px-2 py-2">点赞</th>
                  <th className="px-2 py-2">收藏</th>
                  <th className="px-2 py-2">评论</th>
                  <th className="px-2 py-2">涨粉</th>
                </tr>
              </thead>
              <tbody className="text-slate-700">
                {published.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-sm text-slate-500">
                      暂无已发布记录。点击「同步小红书历史笔记」上传 JSON（含 title 等指标字段）。
                    </td>
                  </tr>
                ) : (
                  published.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100">
                      <td className="max-w-[140px] truncate px-2 py-2">
                        {row.title}
                        {row.metrics_pending ? (
                          <span className="ml-1 text-[10px] text-amber-600">待补数</span>
                        ) : null}
                      </td>
                      <td className="max-w-[120px] truncate px-2 py-2">
                        {row.official_url ? (
                          <a
                            href={row.official_url}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-brand hover:underline"
                          >
                            {row.official_url.replace(/^https?:\/\//, '').slice(0, 32)}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-2 py-2">{fmtInt(row.views)}</td>
                      <td className="px-2 py-2">{fmtPct(row.click_rate_pct)}</td>
                      <td className="px-2 py-2">{fmtInt(row.watch_count)}</td>
                      <td className="px-2 py-2">{fmtInt(row.likes)}</td>
                      <td className="px-2 py-2">{fmtInt(row.favorites)}</td>
                      <td className="px-2 py-2">{fmtInt(row.comments)}</td>
                      <td className="px-2 py-2">{fmtSigned(row.follower_gain)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div id="notes-panel-draft" className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 lg:grid-cols-[220px_1fr]">
          <aside className="border-b border-slate-100 pb-4 lg:border-b-0 lg:border-r lg:pr-4 lg:pb-0">
            <div className="mb-2 text-xs font-medium text-slate-500">分类目录（二级）</div>
            <div className="mb-2 flex flex-wrap gap-1">
              <button
                type="button"
                className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
                onClick={() => void addFolderL1()}
              >
                + 一级
              </button>
            </div>
            <nav className="max-h-[min(52vh,480px)] space-y-0.5 overflow-y-auto pr-1 text-sm">
              <button
                type="button"
                className={`block w-full rounded-lg px-2 py-1.5 text-left ${
                  folderFilter === 'all' ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-50'
                }`}
                onClick={() => setFolderFilter('all')}
              >
                全部草稿
              </button>
              <button
                type="button"
                className={`block w-full rounded-lg px-2 py-1.5 text-left ${
                  folderFilter === 'uncategorized'
                    ? 'bg-slate-100 font-medium text-slate-900'
                    : 'text-slate-600 hover:bg-slate-50'
                }`}
                onClick={() => setFolderFilter('uncategorized')}
              >
                未分类
              </button>
              {folders.map((l1) => (
                <div key={l1.id} className="pt-1">
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 text-slate-400 hover:bg-slate-50"
                      onClick={() => toggleL1Expand(l1.id)}
                      aria-label={expandedL1.has(l1.id) ? '收起' : '展开'}
                    >
                      {expandedL1.has(l1.id) ? '▾' : '▸'}
                    </button>
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{l1.name}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 text-[10px] text-slate-400 hover:text-brand"
                      title="添加二级分类"
                      onClick={() => void addFolderL2(l1.id)}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 text-[10px] text-slate-400 hover:text-slate-600"
                      title="重命名"
                      onClick={() => void renameFolder(l1.id, l1.name)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 text-[10px] text-slate-400 hover:text-rose-600"
                      title="删除一级"
                      onClick={() => void removeFolder(l1.id, true)}
                    >
                      ×
                    </button>
                  </div>
                  {expandedL1.has(l1.id) ? (
                    <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-slate-100 pl-2">
                      {l1.children.length === 0 ? (
                        <li className="px-2 py-1 text-[11px] text-slate-400">（暂无二级，点 + 添加）</li>
                      ) : (
                        l1.children.map((l2) => (
                          <li key={l2.id} className="flex items-center gap-0.5">
                            <button
                              type="button"
                              className={`min-w-0 flex-1 truncate rounded-lg px-2 py-1 text-left text-xs ${
                                folderFilter === l2.id
                                  ? 'bg-slate-100 font-medium text-slate-900'
                                  : 'text-slate-600 hover:bg-slate-50'
                              }`}
                              onClick={() => setFolderFilter(l2.id)}
                            >
                              {l2.name}
                            </button>
                            <button
                              type="button"
                              className="shrink-0 text-[10px] text-slate-400 hover:text-slate-600"
                              onClick={() => void renameFolder(l2.id, l2.name)}
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              className="shrink-0 text-[10px] text-slate-400 hover:text-rose-600"
                              onClick={() => void removeFolder(l2.id, false)}
                            >
                              ×
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  ) : null}
                </div>
              ))}
            </nav>
          </aside>
          <div className="min-w-0">
          {drafts.length === 0 ? (
            <p className="text-sm text-slate-500">暂无组合草稿。点击「组合生成新笔记」，从文案版本与图稿池生成。</p>
          ) : visibleDrafts.length === 0 ? (
              <p className="text-sm text-slate-500">当前分类下暂无草稿。</p>
            ) : (
              <ul className="max-h-[min(52vh,520px)] space-y-2 overflow-y-auto pr-1 text-sm text-slate-600">
                {visibleDrafts.map((d) => (
                  <li
                    key={d.id}
                    className="flex flex-col gap-1 border-b border-slate-100 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0 truncate">
                      {d.folder_path ? (
                        <span className="mr-1 text-[11px] text-slate-400">{d.folder_path}</span>
                      ) : null}
                      {(d.snapshot_title || '').trim() || '（无标题）'}
                    </span>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <select
                        className="max-w-[140px] rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600"
                        value={d.folder_id ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          void moveDraftFolder(d.id, v || null)
                        }}
                      >
                        <option value="">未分类</option>
                        {allL2Folders.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.l1Name} / {f.name}
                          </option>
                        ))}
                      </select>
                      <span
                        className={`text-xs ${d.status === 'images_ready' ? 'text-emerald-600' : 'text-slate-400'}`}
                      >
                        {draftStatusLabel(d.status)}
                      </span>
                      <span className="text-[11px] text-slate-300">|</span>
                      <button
                        type="button"
                        className="text-[11px] text-brand hover:underline disabled:opacity-50"
                        disabled={previewBusy}
                        onClick={() => void openPreview(d.id)}
                      >
                        预览
                      </button>
                      <button
                        type="button"
                        className="text-[11px] text-brand hover:underline"
                        onClick={() => void openEdit(d)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="text-[11px] text-slate-600 hover:underline"
                        onClick={() => openWorkbench(d)}
                      >
                        工作台
                      </button>
                      <button
                        type="button"
                        className="text-[11px] text-rose-600 hover:underline"
                        onClick={() => void deleteDraft(d)}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {composeOpen ? (
        <div
          id="modal-compose"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(ev) => ev.target === ev.currentTarget && setComposeOpen(false)}
        >
          <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={(ev) => ev.stopPropagation()}>
            <button
              type="button"
              id="modal-compose-close"
              className="absolute right-4 top-4 text-xl text-slate-400 hover:text-slate-600"
              onClick={() => setComposeOpen(false)}
              aria-label="关闭"
            >
              &times;
            </button>
            <h2 className="mb-2 text-lg font-semibold text-slate-900">组合生成新笔记</h2>
            <p className="mb-4 text-xs text-slate-500">
              选择<strong className="font-medium text-slate-700">文案版本</strong>，并从条目共用图稿池（最多 18 张）勾选配图。生成组合草稿后，在「工作台与发布」载入精修发布。
            </p>

            <div className="space-y-3 text-sm">
              <div>
                <label className="mb-1 block text-xs text-slate-500">保存到分类（可选）</label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={composeFolderL1}
                    disabled={composeBusy}
                    onChange={(e) => {
                      setComposeFolderL1(e.target.value)
                      setComposeFolderL2('')
                    }}
                  >
                    <option value="">（不选一级）</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={composeFolderL2}
                    disabled={composeBusy || !composeFolderL1}
                    onChange={(e) => setComposeFolderL2(e.target.value)}
                  >
                    <option value="">（不选二级）</option>
                    {composeL2Options.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="mt-1 text-[10px] text-slate-400">须选二级目录才会归档；仅选一级时草稿为未分类。</p>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">文案版本</label>
                <select
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={cvId ?? ''}
                  disabled={composeBusy || !copyVersions.length}
                  onChange={(e) => setCvId(e.target.value || null)}
                >
                  {copyVersions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {formatCvLabel(v)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">
                  条目图稿池（多选）
                  <span className="ml-1 text-slate-400">
                    池内 {composePoolImages.length} 张 · 已选 {orderedSelectedIds.length}
                  </span>
                </label>
                {composePoolImages.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    暂无图稿，将生成「仅文案」草稿；请先到「图片生成与管理」入池。
                  </p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto text-xs text-slate-600">
                    {composePoolImages.map((im: DraftImage, idx) => (
                      <label key={im.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={pickedImages.has(im.id)}
                          onChange={() => togglePickImage(im.id)}
                          className="rounded border-slate-300"
                        />
                        <span className="truncate">
                          图稿 #{idx + 1}
                          {im.is_cover ? '（封面）' : ''}
                          {!im.include_in_publish ? ' · 未参与发布' : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              id="modal-compose-confirm"
              className="mt-5 w-full rounded-lg bg-brand py-2.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
              disabled={composeBusy || !cvId}
              onClick={() => void confirmCompose()}
            >
              {composeBusy ? '处理中…' : '生成草稿并加入笔记管理'}
            </button>
          </div>
        </div>
      ) : null}

      {previewBusy || previewDetail ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(ev) => ev.target === ev.currentTarget && setPreviewDetail(null)}
        >
          <div className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
            onClick={(ev) => ev.stopPropagation()}
          >
            <button
              type="button"
              className="absolute right-4 top-4 text-xl text-slate-400 hover:text-slate-600"
              onClick={() => setPreviewDetail(null)}
              aria-label="关闭"
            >
              &times;
            </button>
            <h2 className="mb-1 text-lg font-semibold text-slate-900">草稿预览</h2>
            {previewBusy && !previewDetail ? (
              <p className="text-sm text-slate-500">加载中…</p>
            ) : previewDetail ? (
              <>
                <p className="mb-3 text-xs text-slate-500">
                  {previewDetail.folder_path ? `${previewDetail.folder_path} · ` : ''}
                  {previewDetail.entry_title} · {draftStatusLabel(previewDetail.status)} ·{' '}
                  {formatYmdHm(previewDetail.created_at)}
                </p>
                <div className="mx-auto w-[240px] rounded-[2rem] border-[10px] border-slate-900 bg-white p-2 shadow-lg">
                  {(() => {
                    const cover =
                      previewDetail.snapshot_images[0]?.public_url ??
                      previewDetail.optional_cover_preview_url
                    return cover ? (
                      <div className="relative aspect-[3/4] overflow-hidden rounded-2xl">
                        <img src={cover} alt="" className="h-full w-full object-cover" />
                      </div>
                    ) : (
                      <div className="flex aspect-[3/4] items-end justify-center rounded-2xl bg-gradient-to-b from-rose-100 to-sky-50 pb-4 text-xs text-slate-500">
                        无配图
                      </div>
                    )
                  })()}
                  <p className="mt-2 line-clamp-2 text-sm font-semibold text-slate-900">
                    {(previewDetail.snapshot_title || '').trim() || '（无标题）'}
                  </p>
                  <p className="mt-1 line-clamp-6 whitespace-pre-line text-xs text-slate-600">
                    {previewDetail.snapshot_body || '（无正文）'}
                  </p>
                </div>
                {previewDetail.snapshot_images.length > 1 ? (
                  <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
                    {previewDetail.snapshot_images.map((im) => (
                      <img
                        key={im.id}
                        src={im.public_url}
                        alt=""
                        className="h-16 w-16 shrink-0 rounded-lg border border-slate-200 object-cover"
                      />
                    ))}
                  </div>
                ) : null}
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    onClick={() => {
                      const d = previewDetail
                      setPreviewDetail(null)
                      void openEdit(d)
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="flex-1 rounded-lg bg-brand py-2 text-sm font-medium text-white hover:bg-brand-dark"
                    onClick={() => {
                      openWorkbench(previewDetail)
                      setPreviewDetail(null)
                    }}
                  >
                    去工作台精修
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {editDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(ev) => ev.target === ev.currentTarget && !editBusy && setEditDraft(null)}
        >
          <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
            onClick={(ev) => ev.stopPropagation()}
          >
            <button
              type="button"
              className="absolute right-4 top-4 text-xl text-slate-400 hover:text-slate-600"
              disabled={editBusy}
              onClick={() => setEditDraft(null)}
              aria-label="关闭"
            >
              &times;
            </button>
            <h2 className="mb-2 text-lg font-semibold text-slate-900">编辑组合草稿</h2>
            <p className="mb-4 text-xs text-slate-500">
              修改快照标题、正文与配图；配图来自条目共用图稿池（最多 18 张）。精修发布请用「工作台」。
            </p>
            <div className="space-y-3 text-sm">
              <div>
                <label className="mb-1 block text-xs text-slate-500">标题</label>
                <input
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={editTitle}
                  disabled={editBusy}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">正文</label>
                <textarea
                  rows={8}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-relaxed"
                  value={editBody}
                  disabled={editBusy}
                  onChange={(e) => setEditBody(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">保存到分类（二级）</label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={editFolderL1}
                    disabled={editBusy}
                    onChange={(e) => {
                      setEditFolderL1(e.target.value)
                      setEditFolderL2('')
                    }}
                  >
                    <option value="">（不选一级）</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={editFolderL2}
                    disabled={editBusy || !editFolderL1}
                    onChange={(e) => setEditFolderL2(e.target.value)}
                  >
                    <option value="">未分类</option>
                    {editL2Options.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">配图（多选）</label>
                {!editDetail ? (
                  <p className="text-xs text-slate-400">加载图稿池…</p>
                ) : editPoolImages.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    条目暂无图稿，保存后为「待配图」草稿；请到「图片生成与管理」入池。
                  </p>
                ) : (
                  <div className="max-h-36 space-y-1 overflow-y-auto text-xs text-slate-600">
                    {editPoolImages.map((im: DraftImage, idx) => (
                      <label
                        key={im.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={editPickedImages.has(im.id)}
                          disabled={editBusy}
                          onChange={() => toggleEditPickImage(im.id)}
                          className="rounded border-slate-300"
                        />
                        <span className="truncate">
                          图稿 #{idx + 1}
                          {im.is_cover ? '（封面）' : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-lg border border-slate-200 py-2.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                disabled={editBusy}
                onClick={() => setEditDraft(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="flex-1 rounded-lg bg-brand py-2.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
                disabled={editBusy}
                onClick={() => void saveEdit()}
              >
                {editBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  )
}
