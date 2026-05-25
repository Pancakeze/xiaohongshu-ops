export type AppConfirmOptions = {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作（删除等）使用红色主按钮 */
  danger?: boolean
}

export type AppPromptOptions = {
  title?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
}

type ConfirmItem = {
  kind: 'confirm'
  message: string
  opts?: AppConfirmOptions
  resolve: (value: boolean) => void
}

type PromptItem = {
  kind: 'prompt'
  message: string
  defaultValue: string
  opts?: AppPromptOptions
  resolve: (value: string | null) => void
}

export type AppDialogItem = ConfirmItem | PromptItem

const queue: AppDialogItem[] = []
let pump: (() => void) | null = null

function enqueue(item: AppDialogItem) {
  queue.push(item)
  pump?.()
}

export function registerAppDialogPump(fn: () => void) {
  pump = fn
  fn()
}

export function unregisterAppDialogPump(fn: () => void) {
  if (pump === fn) pump = null
}

export function takeNextAppDialog(): AppDialogItem | undefined {
  return queue.shift()
}

export function appConfirm(message: string, opts?: AppConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    enqueue({ kind: 'confirm', message, opts, resolve })
  })
}

export function appPrompt(
  message: string,
  defaultValue = '',
  opts?: AppPromptOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    enqueue({ kind: 'prompt', message, defaultValue, opts, resolve })
  })
}
