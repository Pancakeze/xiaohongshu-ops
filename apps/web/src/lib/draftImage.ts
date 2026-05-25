import type { DraftImage, DraftImagePool, EntryDetail } from '../lib/api'

export function draftImageDisplayName(im: DraftImage, fallbackIndex: number): string {
  const n = im.name?.trim()
  return n || `图稿 #${fallbackIndex}`
}

export function groupImagesByPool(
  detail: EntryDetail | null,
): { pool: DraftImagePool; images: DraftImage[] }[] {
  if (!detail?.images?.length) return []

  const pools = [...(detail.image_pools ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh-CN'),
  )
  const byPool = new Map<string, DraftImage[]>()
  for (const im of [...detail.images].sort((a, b) => a.sort_order - b.sort_order)) {
    const list = byPool.get(im.pool_id) ?? []
    list.push(im)
    byPool.set(im.pool_id, list)
  }

  const out: { pool: DraftImagePool; images: DraftImage[] }[] = []
  for (const pool of pools) {
    const images = byPool.get(pool.id)
    if (images?.length) out.push({ pool, images })
  }

  for (const [poolId, images] of byPool) {
    if (pools.some((p) => p.id === poolId)) continue
    out.push({
      pool: {
        id: poolId,
        name: '未分组图稿',
        sort_order: 999,
        image_count: images.length,
      },
      images,
    })
  }

  return out
}

export function draftImageMetaSuffix(im: DraftImage): string {
  const parts: string[] = []
  if (im.is_cover) parts.push('封面')
  if (!im.include_in_publish) parts.push('未参与发布')
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}
