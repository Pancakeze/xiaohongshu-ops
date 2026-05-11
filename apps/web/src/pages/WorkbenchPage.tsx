import { Link } from 'react-router-dom'
import type { ChangeEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiUploadEntryImage,
  type DraftImage,
  type EntryDetail,
  type EntrySummary,
} from '../lib/api'
import {
  formatBodyForXhsPublish,
  getBridgeExtensionId,
  parseTopicsInput,
  persistBridgeExtensionId,
  publishClipboardFallback,
  topicsListsEqual,
  tryExtensionPublish,
  tryPingBridgeExtension,
} from '../lib/publishBridge'

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
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [newUrl, setNewUrl] = useState('')
  const [uploadingLocal, setUploadingLocal] = useState(false)
  const [previewTab, setPreviewTab] = useState<'note' | 'cover'>('note')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const localFileInputRef = useRef<HTMLInputElement>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2600)
  }, [])

  const reloadEntry = useCallback(async (id: string) => {
    const d = await apiGet<EntryDetail>(`/api/entries/${id}`)
    setEntry(d)
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
        const id = list[0].id
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

  const sortedImages = useMemo(() => {
    if (!entry?.images) return []
    return [...entry.images].sort((a, b) => a.sort_order - b.sort_order)
  }, [entry])

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
    const firstImageUrl =
      publishImages.find((p) => p.star)?.url || publishImages[0]?.url
    const imageUrls = [...publishImages]
      .sort((a, b) => Number(b.star) - Number(a.star))
      .map((p) => p.url)
      .filter(Boolean)
    tryExtensionPublish(extId, title, publishBody, (r) => {
      if (r.ok) {
        showToast(
          parseTopicsInput(topicsInput).length
            ? '扩展已打开创作页并尝试填入标题与正文（含 # 话题；发布仍须在小红书侧自行确认）。'
            : '扩展已打开创作页并尝试填入标题/正文（无法代你点小红书「发布」，请在创作页核对后自行发布）。',
        )
        return
      }
      const hint = r.reason.length > 120 ? `${r.reason.slice(0, 120)}…` : r.reason
      showToast(`扩展未接通：${hint}。将打开创作页并尝试剪贴板降级。`)
      publishClipboardFallback(
        title,
        body,
        publishImages.map(({ label, star }) => ({ label, star })),
        showToast,
        topicList,
      )
    }, { firstImageUrl, imageUrls: imageUrls.length ? imageUrls : undefined })
  }

  const saveExtId = () => {
    persistBridgeExtensionId(extIdInput)
    showToast('扩展 ID 已保存到本页')
  }

  const handlePingExtension = () => {
    const extId = getBridgeExtensionId(extIdInput)
    tryPingBridgeExtension(extId, (r) => {
      if (r.ok) {
        showToast(`扩展已连通（桥接 v${r.version}）。创作页里的 invalid 扩展地址可忽略。`)
      } else {
        const hint = r.reason.length > 100 ? `${r.reason.slice(0, 100)}…` : r.reason
        showToast(`扩展未连通：${hint}`)
      }
    })
  }

  const addImage = async () => {
    if (!entryId || !newUrl.trim()) return
    try {
      await apiPost<DraftImage>(`/api/entries/${entryId}/images`, {
        public_url: newUrl.trim(),
        include_in_publish: true,
      })
      setNewUrl('')
      await reloadEntry(entryId)
      showToast('已添加配图')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '添加失败')
    }
  }

  const onLocalFilesChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!entryId || !files?.length) return
    setUploadingLocal(true)
    try {
      let n = 0
      for (const f of Array.from(files)) {
        if (!f.type.startsWith('image/')) continue
        await apiUploadEntryImage(entryId, f)
        n += 1
      }
      if (n) {
        await reloadEntry(entryId)
        showToast(`已上传 ${n} 张本地图片`)
      } else {
        showToast('请选择图片文件')
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
    } catch (e) {
      showToast(e instanceof Error ? e.message : '更新失败')
    }
  }

  const removeImage = async (img: DraftImage) => {
    if (!entryId) return
    try {
      await apiDelete(`/api/entries/${entryId}/images/${img.id}`)
      await reloadEntry(entryId)
      showToast('已移除')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  const entryShort = entryId ? `#${entryId.replace(/-/g, '').slice(-4)}` : '#042'

  if (loadErr) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-red-100 bg-white p-8 text-slate-800 shadow-sm">
        <p className="font-medium text-red-600">加载失败</p>
        <p className="mt-2 text-sm text-slate-600">{loadErr}</p>
        <p className="mt-4 text-sm text-slate-500">
          请确认已启动 PostgreSQL、API（端口 8000），且 <code className="rounded bg-slate-100 px-1">apps/web/.env</code> 中{' '}
          <code className="rounded bg-slate-100 px-1">VITE_API_BEARER_TOKEN</code> 与 API 的{' '}
          <code className="rounded bg-slate-100 px-1">API_BEARER_TOKEN</code> 一致。
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

      <div className="mb-4 max-w-4xl rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-white">
        <strong className="text-slate-200">工作台与发布</strong>
        <br />
        左侧<strong>图文编辑</strong>与右侧<strong>手机预览</strong>（笔记/封面）联动主文案与图稿池；底部<strong>发布到小红书</strong>优先调用已安装的{' '}
        <strong>Chrome 发布桥接扩展</strong>（见 <code className="text-slate-300">extensions/xhs-publish-bridge</code>
        ），失败时降级为「新标签 + 剪贴板」。路由 <code className="text-slate-300">/workbench</code>。
      </div>
      <p className="mb-4 text-xs text-slate-500">
        实施优先级见 <code className="text-slate-600">docs/plan-workbench-publish-first.md</code>；其他模块为占位演示。
        {saving ? <span className="ml-2 text-brand">· 保存中…</span> : null}
      </p>

      <div className="grid items-start gap-6 xl:grid-cols-[1fr_320px]">
        {/* 左：图文编辑卡片 */}
        <div className="flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-3">
            <span className="text-sm font-semibold text-slate-900">图文编辑</span>
            <span className="text-xs text-slate-400">条目 {entryShort}</span>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {/* 从笔记管理载入（占位，对齐原型） */}
            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/90 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                <div className="min-w-0 flex-1 sm:min-w-[220px]">
                  <label className="mb-1 block text-xs text-slate-500">从笔记管理选择笔记，填充标题与正文</label>
                  <select
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-400"
                    disabled
                    defaultValue=""
                  >
                    <option value="">— 请选择笔记 —</option>
                  </select>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    disabled
                  >
                    载入到编辑区
                  </button>
                  <Link to="/notes" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">
                    去笔记管理
                  </Link>
                </div>
              </div>
              <p className="text-xs text-slate-400">
                示意：拉取笔记管理中的标题与正文；图稿仍以「图片生成与管理」图稿池为准，载入后可在下方继续改。
              </p>
            </div>

            {/* 图片条 */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-800">图片编辑</span>
                <span className="text-xs text-slate-500">
                  {sortedImages.filter((i) => i.include_in_publish).length}/18 · 参与发布
                </span>
              </div>
              <div className="flex min-h-[5.5rem] flex-wrap items-center gap-2">
                {sortedImages.map((img) => (
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
                {sortedImages.length === 0 && (
                  <span className="text-xs text-slate-400">
                    可选本地图片上传，或填写下方 HTTPS 图片地址，或去生图页维护图稿池
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
                  去「图片生成与管理」生图
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
              若已填写下方<strong>扩展 ID</strong>且已加载桥接扩展：由扩展打开创作页并尝试<strong>直接写入</strong>标题与正文。否则：新标签打开创作页，并将标题、正文与配图清单写入<strong>剪贴板</strong>。
            </p>
            <div className="mt-3 border-t border-slate-200/90 pt-3">
              <label htmlFor="xhs-bridge-ext-id" className="mb-1 block text-xs text-slate-500">
                Chrome 扩展 ID（<code className="text-[0.65rem]">xhs-publish-bridge</code>，可选）
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="xhs-bridge-ext-id"
                  type="text"
                  autoComplete="off"
                  placeholder="chrome://extensions 中复制"
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
                  检测扩展连接
                </button>
              </div>
              <p className="mt-1.5 text-[0.65rem] leading-relaxed text-slate-400">
                创作页控制台里的 <code className="text-slate-500">chrome-extension://invalid/</code>{' '}
                多为小红书站点脚本发起，<strong>不能</strong>用来判断桥接是否连通；请以本页「检测扩展连接」或点「发布到小红书」后的提示为准。
              </p>
            </div>
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
