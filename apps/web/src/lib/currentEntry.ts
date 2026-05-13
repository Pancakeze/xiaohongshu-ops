import { apiGet, type EntrySummary } from './api'

export const XHS_CURRENT_ENTRY_KEY = 'xhs_current_entry_id'

export function persistCurrentEntryId(entryId: string | null) {
  if (entryId) sessionStorage.setItem(XHS_CURRENT_ENTRY_KEY, entryId)
  else sessionStorage.removeItem(XHS_CURRENT_ENTRY_KEY)
}

/** 会话内当前条目；无则回退为列表首条（与 Workbench 默认一致） */
export async function resolveCurrentEntryId(): Promise<string | null> {
  const raw = sessionStorage.getItem(XHS_CURRENT_ENTRY_KEY)
  if (raw) return raw
  try {
    const list = await apiGet<EntrySummary[]>('/api/entries')
    return list[0]?.id ?? null
  } catch {
    return null
  }
}
