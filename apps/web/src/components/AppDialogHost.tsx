import { useCallback, useEffect, useRef, useState } from 'react'
import {
  registerAppDialogPump,
  takeNextAppDialog,
  unregisterAppDialogPump,
  type AppDialogItem,
} from '../lib/appDialog'

export function AppDialogHost() {
  const [active, setActive] = useState<AppDialogItem | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<AppDialogItem | null>(null)
  activeRef.current = active

  const showNext = useCallback(() => {
    if (activeRef.current) return
    const next = takeNextAppDialog()
    if (!next) return
    if (next.kind === 'prompt') setPromptValue(next.defaultValue)
    setActive(next)
  }, [])

  useEffect(() => {
    registerAppDialogPump(showNext)
    return () => unregisterAppDialogPump(showNext)
  }, [showNext])

  useEffect(() => {
    if (active?.kind !== 'prompt') return
    const t = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [active])

  const finish = useCallback(
    (result: boolean | string | null) => {
      const item = activeRef.current
      if (!item) return
      if (item.kind === 'confirm') item.resolve(!!result)
      else item.resolve(typeof result === 'string' ? result : null)
      setActive(null)
      window.setTimeout(showNext, 0)
    },
    [showNext],
  )

  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(active.kind === 'confirm' ? false : null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, finish])

  if (!active) return null

  const title =
    active.kind === 'confirm'
      ? (active.opts?.title ?? '请确认')
      : (active.opts?.title ?? active.message)

  const description =
    active.kind === 'prompt' && active.opts?.title ? active.message : null

  const confirmLabel =
    active.kind === 'confirm'
      ? (active.opts?.confirmLabel ?? '确定')
      : (active.opts?.confirmLabel ?? '确定')

  const cancelLabel =
    active.kind === 'confirm'
      ? (active.opts?.cancelLabel ?? '取消')
      : (active.opts?.cancelLabel ?? '取消')

  const danger = active.kind === 'confirm' && active.opts?.danger

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-dialog-title"
      onClick={() => finish(active.kind === 'confirm' ? false : null)}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-slate-200/80"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="app-dialog-title" className="text-base font-semibold text-slate-900">
          {title}
        </h2>

        {active.kind === 'confirm' ? (
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-600">
            {active.message}
          </p>
        ) : (
          <div className="mt-3">
            {description ? (
              <p className="mb-2 text-sm text-slate-500">{description}</p>
            ) : null}
            <input
              ref={inputRef}
              type="text"
              value={promptValue}
              placeholder={active.opts?.placeholder}
              className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-900 outline-none ring-brand/30 transition focus:border-brand focus:ring-2"
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  finish(promptValue)
                }
              }}
            />
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => finish(active.kind === 'confirm' ? false : null)}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus={active.kind === 'confirm'}
            className={
              danger
                ? 'rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700'
                : 'rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark'
            }
            onClick={() => {
              if (active.kind === 'confirm') finish(true)
              else finish(promptValue)
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
