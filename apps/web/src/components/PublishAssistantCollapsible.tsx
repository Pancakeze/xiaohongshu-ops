import type { ReactNode } from 'react'

type Props = {
  className?: string
  hint?: ReactNode
  children: ReactNode
}

/** 发布助手编号等配置，默认折叠以节省版面 */
export function PublishAssistantCollapsible({ className = '', hint, children }: Props) {
  return (
    <details
      className={`group rounded-lg border border-slate-200 bg-slate-50/80 ${className}`.trim()}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-xs font-medium text-slate-800 [&::-webkit-details-marker]:hidden">
        <span>发布助手</span>
        <span className="shrink-0 text-[10px] font-normal text-slate-400 group-open:hidden">展开</span>
        <span className="hidden shrink-0 text-[10px] font-normal text-slate-400 group-open:inline">收起</span>
      </summary>
      <div className="border-t border-slate-200/80 px-4 pb-4 pt-3">
        {hint ? <p className="mb-3 text-[11px] leading-relaxed text-slate-500">{hint}</p> : null}
        {children}
      </div>
    </details>
  )
}
