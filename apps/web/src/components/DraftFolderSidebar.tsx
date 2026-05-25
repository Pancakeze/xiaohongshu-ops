import type { ReactNode } from 'react'
import type { DraftFolderTree } from '../lib/api'

type FolderFilter = 'all' | 'uncategorized' | string

type Props = {
  folders: DraftFolderTree[]
  folderFilter: FolderFilter
  expandedL1: Set<string>
  onFilterChange: (filter: FolderFilter) => void
  onToggleL1Expand: (id: string) => void
  onAddL1: () => void
  onAddL2: (parentId: string) => void
  onRename: (id: string, current: string) => void
  onRemove: (id: string, isL1: boolean) => void
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden
    >
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconButton({
  label,
  onClick,
  danger = false,
  children,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-white hover:shadow-sm ${
        danger ? 'hover:text-rose-600' : 'hover:text-brand'
      }`}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

function FilterItem({
  active,
  label,
  onClick,
  indent = false,
}: {
  active: boolean
  label: string
  onClick: () => void
  indent?: boolean
}) {
  return (
    <button
      type="button"
      className={`block w-full truncate rounded-lg py-1.5 text-left text-sm transition ${
        indent ? 'pl-7 pr-2 text-[13px]' : 'px-2.5'
      } ${
        active
          ? 'bg-brand/10 font-medium text-brand ring-1 ring-brand/15'
          : 'text-slate-600 hover:bg-slate-100/80'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

export function DraftFolderSidebar({
  folders,
  folderFilter,
  expandedL1,
  onFilterChange,
  onToggleL1Expand,
  onAddL1,
  onAddL2,
  onRename,
  onRemove,
}: Props) {
  return (
    <aside className="border-b border-slate-100 pb-4 lg:border-b-0 lg:border-r lg:pr-4 lg:pb-0">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold tracking-wide text-slate-700">分类目录</div>
          <div className="text-[10px] text-slate-400">一级 · 二级归档</div>
        </div>
      </div>

      <button
        type="button"
        className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 bg-slate-50/80 px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-brand/50 hover:bg-brand/5 hover:text-brand"
        onClick={onAddL1}
      >
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white text-sm leading-none shadow-sm">
          +
        </span>
        新建一级分类
      </button>

      <nav className="max-h-[min(52vh,480px)] space-y-1 overflow-y-auto pr-0.5 text-sm">
        <FilterItem
          active={folderFilter === 'all'}
          label="全部草稿"
          onClick={() => onFilterChange('all')}
        />
        <FilterItem
          active={folderFilter === 'uncategorized'}
          label="未分类"
          onClick={() => onFilterChange('uncategorized')}
        />

        {folders.length > 0 ? (
          <div className="my-2 border-t border-slate-100 pt-2">
            <div className="mb-1 px-2.5 text-[10px] font-medium uppercase tracking-wider text-slate-400">
              我的分类
            </div>
          </div>
        ) : null}

        {folders.map((l1) => {
          const open = expandedL1.has(l1.id)
          return (
            <div key={l1.id} className="group/l1">
              <div
                className={`flex items-center gap-0.5 rounded-lg pr-1 transition hover:bg-slate-50 ${
                  open ? 'bg-slate-50/60' : ''
                }`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-lg py-1.5 pl-1.5 pr-1 text-left"
                  onClick={() => onToggleL1Expand(l1.id)}
                >
                  <ChevronIcon open={open} />
                  <span className="truncate text-sm font-medium text-slate-800">{l1.name}</span>
                  {l1.children.length > 0 ? (
                    <span className="shrink-0 rounded-full bg-slate-200/80 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-500">
                      {l1.children.length}
                    </span>
                  ) : null}
                </button>
                <div className="flex shrink-0 items-center opacity-100 transition sm:opacity-0 sm:group-hover/l1:opacity-100">
                  <IconButton label="添加二级分类" onClick={() => onAddL2(l1.id)}>
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
                      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </IconButton>
                  <IconButton label="重命名" onClick={() => onRename(l1.id, l1.name)}>
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
                      <path
                        d="M11.5 2.5l2 2L6 12H4v-2l7.5-7.5z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </IconButton>
                  <IconButton label="删除一级分类" danger onClick={() => onRemove(l1.id, true)}>
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </IconButton>
                </div>
              </div>

              {open ? (
                <div className="ml-3 mt-0.5 space-y-0.5 border-l-2 border-slate-100 pl-2">
                  {l1.children.length === 0 ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-slate-200 px-2.5 py-2 text-left text-[11px] text-slate-400 transition hover:border-brand/40 hover:bg-brand/5 hover:text-brand"
                      onClick={() => onAddL2(l1.id)}
                    >
                      <span className="flex h-4 w-4 items-center justify-center rounded bg-white text-xs shadow-sm">
                        +
                      </span>
                      添加二级分类
                    </button>
                  ) : (
                    l1.children.map((l2) => (
                      <div key={l2.id} className="group/l2 flex items-center gap-0.5">
                        <button
                          type="button"
                          className={`min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-[13px] transition ${
                            folderFilter === l2.id
                              ? 'bg-brand/10 font-medium text-brand ring-1 ring-brand/15'
                              : 'text-slate-600 hover:bg-slate-100/80'
                          }`}
                          onClick={() => onFilterChange(l2.id)}
                        >
                          {l2.name}
                        </button>
                        <div className="flex shrink-0 items-center opacity-100 transition sm:opacity-0 sm:group-hover/l2:opacity-100">
                          <IconButton label="重命名" onClick={() => onRename(l2.id, l2.name)}>
                            <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
                              <path
                                d="M11.5 2.5l2 2L6 12H4v-2l7.5-7.5z"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.25"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </IconButton>
                          <IconButton label="删除二级分类" danger onClick={() => onRemove(l2.id, false)}>
                            <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
                              <path
                                d="M4 4l8 8M12 4l-8 8"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                              />
                            </svg>
                          </IconButton>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
