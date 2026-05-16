/** ISO 时间 → `yyyy-mm-dd hh:mm`（24 小时制，本地时区） */
export function formatYmdHm(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

/** 竞品分析历史：`yyyy-mm-dd hh:mm-关键词` */
export function formatYmdHmDashKeyword(iso: string, keyword: string): string {
  const k = keyword.replace(/\s+/g, ' ').trim().slice(0, 32)
  return `${formatYmdHm(iso)}-${k || '（无来源）'}`
}
