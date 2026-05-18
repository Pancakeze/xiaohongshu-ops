const apiBase = () => (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

function authHeaders(): HeadersInit {
  const token = import.meta.env.VITE_API_BEARER_TOKEN || ''
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}

/** multipart 上传本地图片；勿设置 Content-Type，由浏览器带 boundary */
export async function apiUploadEntryImage(
  entryId: string,
  file: File,
  opts?: { sourceCopyVersionId?: string | null; imagePoolId?: string | null },
): Promise<DraftImage> {
  const fd = new FormData()
  fd.append('file', file)
  if (opts?.sourceCopyVersionId) {
    fd.append('source_copy_version_id', opts.sourceCopyVersionId)
  }
  if (opts?.imagePoolId) {
    fd.append('image_pool_id', opts.imagePoolId)
  }
  const token = import.meta.env.VITE_API_BEARER_TOKEN || ''
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${apiBase()}/api/entries/${entryId}/images/upload`, {
    method: 'POST',
    headers,
    body: fd,
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<DraftImage>
}

export type EntrySummary = { id: string; title: string; updated_at: string }

export type DraftImage = {
  id: string
  pool_id: string
  sort_order: number
  public_url: string
  is_cover: boolean
  include_in_publish: boolean
  /** PRD §5.3：生图/入池时的文案版本溯源 */
  source_copy_version_id?: string | null
  /** 被笔记管理组合草稿快照引用 */
  composed_snapshot_locked?: boolean
}

export type DraftImagePool = {
  id: string
  name: string
  sort_order: number
  image_count: number
}

export type EntryDetail = {
  id: string
  title: string
  body: string
  /** 运营台话题词列表；老接口可能缺省，按 [] 处理 */
  topics?: string[]
  updated_at: string
  images: DraftImage[]
  image_pools?: DraftImagePool[]
  /** 文案生成所选模版（§5.10 / 壳层「选择模版」） */
  selected_template_id?: string | null
  /** PRD §5.3：每组图稿池张数上限（与 API 配置一致） */
  draft_image_pool_limit?: number
}

export type Template = {
  id: string
  name: string
  scenario: string
  structure_description: string
  enabled: boolean
  copy_metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type CopyVersion = {
  id: string
  title: string
  body: string
  source: string
  is_primary: boolean
  created_at: string
}

export type PublishedNote = {
  id: string
  title: string
  /** 已发布笔记正文；手工导入 JSON 可带；缺省为空 */
  body?: string
  official_url: string | null
  views: number | null
  click_rate_pct: number | null
  watch_count: number | null
  likes: number | null
  favorites: number | null
  comments: number | null
  follower_gain: number | null
  synced_at: string
  metrics_pending: boolean
}

export type DraftFolderChild = {
  id: string
  name: string
  parent_id: string | null
  sort_order: number
}

export type DraftFolderTree = {
  id: string
  name: string
  sort_order: number
  children: DraftFolderChild[]
}

export type ComposedDraftRow = {
  id: string
  entry_id: string
  entry_title: string
  snapshot_copy_version_id: string
  snapshot_title: string
  /** 快照文案正文，供工作台从笔记管理载入 */
  snapshot_body?: string
  status: string
  created_at: string
  ordered_image_asset_ids: string[]
  cover_asset_id?: string | null
  optional_cover_preview_url: string | null
  folder_id?: string | null
  folder_path?: string | null
}

export type ComposedDraftSnapshotImage = {
  id: string
  public_url: string
  position: number
}

export type ComposedDraftDetail = ComposedDraftRow & {
  snapshot_images: ComposedDraftSnapshotImage[]
  updated_at: string
}

export type SyncNotesResponse = {
  imported_count: number
  message: string
}

export type OverviewTopNote = {
  id: string
  title: string
  summary: string
  views: number | null
  official_url: string | null
  metrics_pending: boolean
}

/** PRD §5.8 总览聚合 */
export type OverviewPayload = {
  published_notes_total: number
  published_this_week_count: number
  quality_notes_count: number
  quality_views_threshold: number
  pending_composed_drafts_count: number
  week_range_mon_sun_label: string
  top_notes: OverviewTopNote[]
}

export type PublishAttemptRow = {
  id: string
  entry_id: string
  outcome: string
  extension_error: string | null
  bridge_payload: Record<string, unknown> | null
  client_hints: Record<string, unknown> | null
  created_at: string
}

export type CompetitorPage = {
  url: string
  ok: boolean
  error: string | null
  title: string
  description: string
  text_excerpt: string
  text_len: number
}

export type CompetitorAnalyzePayload = {
  fetched: CompetitorPage[]
  top10: CompetitorPage[]
  analysis_markdown: string
  generated_title: string
  generated_body: string
}

export type XhsTopNote = {
  url: string
  title: string
  author?: string | null
  excerpt?: string | null
  like_text?: string | null
}

export type CompetitorAnalyzeXhsPayload = {
  keyword: string
  top10: XhsTopNote[]
  analysis_markdown: string
  generated_title: string
  generated_body: string
  saved_id?: string | null
}

export type CompetitorAnalysisHistoryRow = {
  id: string
  entry_id: string
  source_keyword: string
  top10: XhsTopNote[]
  analysis_markdown: string
  generated_title: string
  generated_body: string
  created_at: string
}

export type GoogleImageAsset = {
  id: string
  turn_id: string
  local_path: string
  public_url?: string | null
  width?: number | null
  height?: number | null
  created_at: string
}

export type GoogleImageTurn = {
  id: string
  session_id: string
  prompt: string
  params: Record<string, unknown>
  result_summary: string
  last_error?: string | null
  created_at: string
  assets: GoogleImageAsset[]
}

export type GoogleImageSession = {
  id: string
  owner_id: string
  status: string
  last_error?: string | null
  created_at: string
  updated_at: string
  turns: GoogleImageTurn[]
}

export type GoogleImageSessionCreateOut = { id: string }

export async function apiCreateGoogleImageSession(): Promise<GoogleImageSessionCreateOut> {
  return apiPost<GoogleImageSessionCreateOut>('/api/google-image/sessions', {})
}

export async function apiGetGoogleImageSession(sessionId: string): Promise<GoogleImageSession> {
  return apiGet<GoogleImageSession>(`/api/google-image/sessions/${sessionId}`)
}
