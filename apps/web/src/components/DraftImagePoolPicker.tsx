import { apiPatch, type DraftImage, type EntryDetail } from '../lib/api'
import { appPrompt } from '../lib/appDialog'
import {
  draftImageDisplayName,
  draftImageMetaSuffix,
  groupImagesByPool,
} from '../lib/draftImage'

type Props = {
  entryId: string | null
  detail: EntryDetail | null
  picked: Set<string>
  disabled?: boolean
  onToggle: (id: string) => void
  onPickedChange: (next: Set<string>) => void
  onDetailChange: (next: EntryDetail) => void
  onError?: (message: string) => void
  emptyHint?: string
  maxHeightClass?: string
}

export function DraftImagePoolPicker({
  entryId,
  detail,
  picked,
  disabled = false,
  onToggle,
  onPickedChange,
  onDetailChange,
  onError,
  emptyHint = '暂无图稿，将生成「仅文案」草稿；请先到「图片管理」入池。',
  maxHeightClass = 'max-h-48',
}: Props) {
  const groups = groupImagesByPool(detail)
  const allIds = groups.flatMap(({ images }) => images.map((im) => im.id))

  const selectAll = () => {
    if (disabled) return
    onPickedChange(new Set(allIds))
  }

  const invertSelection = () => {
    if (disabled) return
    const next = new Set<string>()
    for (const id of allIds) {
      if (!picked.has(id)) next.add(id)
    }
    onPickedChange(next)
  }

  const renameImage = async (im: DraftImage, fallbackIndex: number) => {
    if (!entryId || disabled) return
    const current = draftImageDisplayName(im, fallbackIndex)
    const raw = await appPrompt('图稿名称', im.name?.trim() ? current : '', { title: '重命名图稿' })
    if (raw === null) return
    try {
      const updated = await apiPatch<DraftImage>(`/api/entries/${entryId}/images/${im.id}`, {
        name: raw.trim(),
      })
      if (!detail) return
      onDetailChange({
        ...detail,
        images: detail.images.map((row) => (row.id === updated.id ? updated : row)),
      })
    } catch (e) {
      onError?.(e instanceof Error ? e.message : '重命名失败')
    }
  }

  if (!groups.length) {
    return <p className="text-xs text-slate-400">{emptyHint}</p>
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled || allIds.length === 0}
          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          onClick={selectAll}
        >
          全选
        </button>
        <button
          type="button"
          disabled={disabled || allIds.length === 0}
          className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          onClick={invertSelection}
        >
          反选
        </button>
        <span className="self-center text-[10px] text-slate-400">
          已选 {picked.size}/{allIds.length}
        </span>
      </div>
      <div className={`space-y-3 overflow-y-auto pr-1 text-xs text-slate-600 ${maxHeightClass}`}>
      {groups.map(({ pool, images }) => (
        <div key={pool.id} className="rounded-lg border border-slate-100 bg-slate-50/60 p-2">
          <p className="mb-1.5 px-1 text-[11px] font-semibold text-slate-700">
            {pool.name}
            <span className="ml-1 font-normal text-slate-400">({images.length} 张)</span>
          </p>
          <ul className="space-y-0.5">
            {images.map((im, idx) => {
              const label = draftImageDisplayName(im, idx + 1)
              return (
                <li
                  key={im.id}
                  className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-white/80"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={picked.has(im.id)}
                      disabled={disabled}
                      onChange={() => onToggle(im.id)}
                      className="shrink-0 rounded border-slate-300"
                    />
                    <img
                      src={im.public_url}
                      alt=""
                      className="h-8 w-8 shrink-0 rounded border border-slate-200 object-cover"
                    />
                    <span className="min-w-0 truncate">
                      {label}
                      <span className="text-slate-400">{draftImageMetaSuffix(im)}</span>
                    </span>
                  </label>
                  <button
                    type="button"
                    disabled={disabled || !entryId}
                    className="shrink-0 text-[10px] text-brand hover:underline disabled:opacity-40"
                    onClick={() => void renameImage(im, idx + 1)}
                  >
                    命名
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      </div>
    </div>
  )
}
