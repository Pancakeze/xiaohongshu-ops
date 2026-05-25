import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { FONT_FAMILIES, FONT_SIZES } from '../lib/genParamCanvas'

type Props = {
  value: string
  onChange: (html: string) => void
  className?: string
  minHeight?: string
}

function ToolbarButton({
  label,
  title,
  active,
  onClick,
}: {
  label: ReactNode
  title: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-brand-soft text-brand-dark'
          : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {label}
    </button>
  )
}

export function GenParamRichEditor({ value, onChange, className = '', minHeight = '12rem' }: Props) {
  const editorRef = useRef<HTMLDivElement>(null)
  const lastValueRef = useRef(value)
  const mountedRef = useRef(false)

  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (!mountedRef.current) {
      el.innerHTML = value
      mountedRef.current = true
      lastValueRef.current = value
      return
    }
    if (value === lastValueRef.current) return
    if (el.innerHTML !== value) {
      el.innerHTML = value
    }
    lastValueRef.current = value
  }, [value])

  const sync = useCallback(() => {
    const html = editorRef.current?.innerHTML ?? ''
    lastValueRef.current = html
    onChange(html)
  }, [onChange])

  const exec = useCallback(
    (cmd: string, val?: string) => {
      editorRef.current?.focus()
      document.execCommand(cmd, false, val)
      sync()
    },
    [sync],
  )

  const applyInlineStyle = useCallback(
    (prop: string, val: string) => {
      editorRef.current?.focus()
      const sel = window.getSelection()
      if (!sel?.rangeCount) return
      const style = `${prop}:${val}`
      if (sel.isCollapsed) {
        document.execCommand(
          'insertHTML',
          false,
          `<span style="${style}">\u200B</span>`,
        )
      } else {
        document.execCommand('insertHTML', false, `<span style="${style}">${sel.toString()}</span>`)
      }
      sync()
    },
    [sync],
  )

  const queryState = (cmd: string) => {
    try {
      return document.queryCommandState(cmd)
    } catch {
      return false
    }
  }

  return (
    <div className={`overflow-hidden rounded-lg border border-slate-200 bg-white ${className}`.trim()}>
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 bg-slate-50/80 px-2 py-1.5">
        <select
          className="max-w-[7rem] rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-700"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) applyInlineStyle('font-family', e.target.value)
            e.target.value = ''
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <option value="" disabled>
            字体
          </option>
          {FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          className="w-14 rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-700"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) applyInlineStyle('font-size', `${e.target.value}px`)
            e.target.value = ''
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <option value="" disabled>
            字号
          </option>
          {FONT_SIZES.map((s) => (
            <option key={s} value={String(s)}>
              {s}px
            </option>
          ))}
        </select>
        <span className="mx-0.5 h-4 w-px bg-slate-200" aria-hidden />
        <ToolbarButton
          label={<strong>B</strong>}
          title="加粗"
          active={queryState('bold')}
          onClick={() => exec('bold')}
        />
        <ToolbarButton
          label={<em>I</em>}
          title="斜体"
          active={queryState('italic')}
          onClick={() => exec('italic')}
        />
        <ToolbarButton
          label={<span className="underline">U</span>}
          title="下划线"
          active={queryState('underline')}
          onClick={() => exec('underline')}
        />
        <label
          className="relative ml-0.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded hover:bg-slate-100"
          title="选中文字颜色"
          onMouseDown={(e) => e.preventDefault()}
        >
          <span className="text-[11px] font-bold text-slate-600">A</span>
          <input
            type="color"
            className="absolute inset-0 cursor-pointer opacity-0"
            defaultValue="#0f172a"
            onChange={(e) => exec('foreColor', e.target.value)}
          />
        </label>
        <ToolbarButton label="清除格式" title="清除格式" onClick={() => exec('removeFormat')} />
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        className="px-3 py-2.5 text-sm leading-relaxed text-slate-800 outline-none [&_p]:my-1"
        style={{ minHeight }}
        onInput={sync}
        onBlur={sync}
      />
    </div>
  )
}
