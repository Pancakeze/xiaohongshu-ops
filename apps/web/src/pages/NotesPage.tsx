import type { ChangeEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  apiGet,
  apiPost,
  type ComposedDraftRow,
  type CopyVersion,
  type DraftImage,
  type EntryDetail,
  type EntrySummary,
  type PublishedNote,
  type SyncNotesResponse,
} from '../lib/api'
import { persistCurrentEntryId, resolveCurrentEntryId } from '../lib/currentEntry'

type NotesTab = 'hist' | 'draft'

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
  const time = new Date(v.created_at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const tag = v.source === 'manual' ? '人工' : '生成'
  return `${t.slice(0, 24)}${t.length > 24 ? '…' : ''} · ${tag} · ${time}`
}

export function NotesPage() {
  const [tab, setTab] = useState<NotesTab>('hist')
  const [published, setPublished] = useState<PublishedNote[]>([])
  const [drafts, setDrafts] = useState<ComposedDraftRow[]>([])
  const [entries, setEntries] = useState<EntrySummary[]>([])
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

  const loadAll = useCallback(async () => {
    try {
      setLoadErr(null)
      const [pub, dr, ent] = await Promise.all([
        apiGet<PublishedNote[]>('/api/notes/published'),
        apiGet<ComposedDraftRow[]>('/api/notes/composed-drafts'),
        apiGet<EntrySummary[]>('/api/entries'),
      ])
      setPublished(pub)
      setDrafts(dr)
      setEntries(ent)
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const openCompose = async () => {
    try {
      const entList = entries.length ? entries : await apiGet<EntrySummary[]>('/api/entries')
      setEntries(entList)
      if (!entList.length) {
        showToast('暂无内容条目，请先在工作台创建或加载条目')
        return
      }
      let eid = await resolveCurrentEntryId()
      if (!eid || !entList.some((e) => e.id === eid)) {
        eid = entList[0].id
      }
      setComposeEntryId(eid)
      setComposeOpen(true)
      setComposeBusy(true)
      const [detail, cvs] = await Promise.all([
        apiGet<EntryDetail>(`/api/entries/${eid}`),
        apiGet<CopyVersion[]>(`/api/entries/${eid}/copy-versions`),
      ])
      setComposeDetail(detail)
      setCopyVersions(cvs)
      const primary = cvs.find((c) => c.is_primary)
      setCvId((primary ?? cvs[0])?.id ?? null)
      setPickedImages(new Set())
      setComposeBusy(false)
    } catch (e) {
      setComposeBusy(false)
      showToast(e instanceof Error ? e.message : '加载失败')
    }
  }

  const reloadComposeContext = async (eid: string) => {
    setComposeBusy(true)
    try {
      const [detail, cvs] = await Promise.all([
        apiGet<EntryDetail>(`/api/entries/${eid}`),
        apiGet<CopyVersion[]>(`/api/entries/${eid}/copy-versions`),
      ])
      setComposeDetail(detail)
      setCopyVersions(cvs)
      const primary = cvs.find((c) => c.is_primary)
      setCvId((primary ?? cvs[0])?.id ?? null)
      setPickedImages(new Set())
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加载失败')
    } finally {
      setComposeBusy(false)
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

  const sortedImages = useMemo(() => {
    if (!composeDetail?.images) return []
    return [...composeDetail.images].sort((a, b) => a.sort_order - b.sort_order)
  }, [composeDetail])

  const orderedSelectedIds = useMemo(() => {
    return sortedImages.filter((im) => pickedImages.has(im.id)).map((im) => im.id)
  }, [sortedImages, pickedImages])

  const coverAssetId = useMemo(() => {
    const selected = sortedImages.filter((im) => pickedImages.has(im.id))
    const starred = selected.find((im) => im.is_cover)
    return starred?.id ?? selected[0]?.id ?? null
  }, [sortedImages, pickedImages])

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
        <div id="notes-panel-draft" className="rounded-xl border border-slate-200 bg-white p-5">
          {drafts.length === 0 ? (
            <p className="text-sm text-slate-500">暂无组合草稿。点击「组合生成新笔记」从当前条目的文案版本与图稿池生成。</p>
          ) : (
            <ul className="space-y-2 text-sm text-slate-600">
              {drafts.map((d) => (
                <li key={d.id} className="flex justify-between gap-3 border-b border-slate-100 py-2 last:border-0">
                  <span className="min-w-0 truncate">
                    <span className="text-slate-500">{d.entry_title}</span>
                    {' · '}
                    {(d.snapshot_title || '').trim() || '（无标题）'}
                  </span>
                  <span
                    className={`shrink-0 text-xs ${d.status === 'images_ready' ? 'text-emerald-600' : 'text-slate-400'}`}
                  >
                    {draftStatusLabel(d.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
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
              选择<strong className="font-medium text-slate-700">文案版本</strong>与<strong className="font-medium text-slate-700">图稿池中的图</strong>
              ，生成新草稿并进入笔记管理；精修与预览在「工作台与发布」页完成。
            </p>

            <div className="space-y-3 text-sm">
              <div>
                <label className="mb-1 block text-xs text-slate-500">内容条目</label>
                <select
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={composeEntryId ?? ''}
                  disabled={composeBusy}
                  onChange={(e) => {
                    const id = e.target.value
                    setComposeEntryId(id)
                    persistCurrentEntryId(id)
                    void reloadComposeContext(id)
                  }}
                >
                  {entries.map((en) => (
                    <option key={en.id} value={en.id}>
                      {en.title.trim() || '（无标题）'}
                    </option>
                  ))}
                </select>
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
                <label className="mb-1 block text-xs text-slate-500">图片（多选）</label>
                {sortedImages.length === 0 ? (
                  <p className="text-xs text-slate-400">当前条目暂无图稿，将生成「仅文案」草稿；也可先到「图片生成与管理」入池。</p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto text-xs text-slate-600">
                    {sortedImages.map((im: DraftImage) => (
                      <label key={im.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={pickedImages.has(im.id)}
                          onChange={() => togglePickImage(im.id)}
                          className="rounded border-slate-300"
                        />
                        <span className="truncate">
                          图稿 #{im.sort_order + 1}
                          {im.is_cover ? '（封面）' : ''}
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

      {toast ? (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  )
}
