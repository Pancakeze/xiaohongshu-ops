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
export async function apiUploadEntryImage(entryId: string, file: File): Promise<DraftImage> {
  const fd = new FormData()
  fd.append('file', file)
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
  sort_order: number
  public_url: string
  is_cover: boolean
  include_in_publish: boolean
}

export type EntryDetail = {
  id: string
  title: string
  body: string
  /** 运营台话题词列表；老接口可能缺省，按 [] 处理 */
  topics?: string[]
  updated_at: string
  images: DraftImage[]
}
