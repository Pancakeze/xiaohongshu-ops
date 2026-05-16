import { apiGet, type EntrySummary } from './api'

export const XHS_CURRENT_ENTRY_KEY = 'xhs_current_entry_id'
/** 从笔记管理跳转工作台时，待自动载入的组合草稿 id */
export const XHS_PENDING_LOAD_COMPOSED_DRAFT = 'xhs:pending_load_composed_draft'

export function scheduleWorkbenchLoadComposedDraft(draftId: string) {
  sessionStorage.setItem(XHS_PENDING_LOAD_COMPOSED_DRAFT, draftId)
}

export function persistCurrentEntryId(entryId: string | null) {
  const prev = sessionStorage.getItem(XHS_CURRENT_ENTRY_KEY)
  if (entryId) sessionStorage.setItem(XHS_CURRENT_ENTRY_KEY, entryId)
  else sessionStorage.removeItem(XHS_CURRENT_ENTRY_KEY)
  if (prev !== (entryId ?? null)) {
    window.dispatchEvent(
      new CustomEvent('xhs:current-entry-changed', { detail: { entryId } }),
    )
  }
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
