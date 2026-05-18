import { Link, Outlet, useLocation } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPatch, type EntryDetail, type Template } from '../lib/api'
import { resolveCurrentEntryId } from '../lib/currentEntry'

const ROUTE_TITLES: Record<string, string> = {
  '/dash': '总览',
  '/copy': '文案管理',
  '/images': '图片管理',
  '/templates': '模版管理',
  '/notes': '笔记管理',
  '/workbench': '工作台',
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  const { pathname } = useLocation()
  const active = pathname === to
  return (
    <Link
      to={to}
      className={`nav-item flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
        active ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-50'
      }`}
    >
      {children}
    </Link>
  )
}

function TemplatePickerModal({
  open,
  onClose,
  onPicked,
}: {
  open: boolean
  onClose: () => void
  onPicked: (name: string) => void
}) {
  const [list, setList] = useState<Template[]>([])
  const [entryId, setEntryId] = useState<string | null>(null)
  const [currentSelected, setCurrentSelected] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      setHint(null)
      const eid = await resolveCurrentEntryId()
      if (cancelled) return
      setEntryId(eid)
      try {
        const tpls = await apiGet<Template[]>('/api/templates?enabled=true')
        if (cancelled) return
        setList(tpls)
        if (!tpls.length) {
          setHint('暂无启用中的模版，请前往「模版管理」启用或新建。')
        }
        if (eid) {
          const entry = await apiGet<EntryDetail>(`/api/entries/${eid}`)
          if (cancelled) return
          setCurrentSelected(entry.selected_template_id ?? null)
        } else {
          setCurrentSelected(null)
          setHint((h) => h ?? '暂无内容条目，请先打开工作台加载条目。')
        }
      } catch (e) {
        if (!cancelled) setHint(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const pick = async (t: Template) => {
    if (!entryId) {
      setHint('无法绑定模版：没有可用的内容条目。')
      return
    }
    try {
      await apiPatch<EntryDetail>(`/api/entries/${entryId}`, { selected_template_id: t.id })
      setCurrentSelected(t.id)
      onPicked(t.name)
      window.dispatchEvent(
        new CustomEvent('xhs:template-selected', { detail: { entryId, templateId: t.id } }),
      )
      onClose()
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e))
    }
  }

  if (!open) return null

  return (
    <div
      id="modal-templates"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-hidden={false}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          id="modal-templates-close"
          className="absolute right-4 top-4 text-xl leading-none text-slate-400 hover:text-slate-600"
          onClick={onClose}
          aria-label="关闭"
        >
          &times;
        </button>
        <h2 className="mb-4 text-lg font-semibold text-slate-900">选择模版</h2>
        {hint ? <p className="mb-3 text-xs text-amber-800">{hint}</p> : null}
        <div className="space-y-2">
          {list.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tpl-pick w-full rounded-xl border px-4 py-3 text-left text-sm transition-colors hover:border-brand hover:bg-brand-soft ${
                currentSelected === t.id ? 'border-brand bg-brand-soft' : 'border-slate-200'
              }`}
              onClick={() => void pick(t)}
            >
              {t.name}
            </button>
          ))}
        </div>
        <p className="mt-4 text-xs text-slate-400">
          仅展示<strong>启用中</strong>模版（PRD §5.2）。完整管理见「模版库」。
        </p>
      </div>
    </div>
  )
}

export function AppShell() {
  const { pathname } = useLocation()
  const pageTitle = ROUTE_TITLES[pathname] || '运营工作台'
  const [tplModalOpen, setTplModalOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2600)
  }, [])

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900 antialiased">
      <aside
        id="sidebar"
        className="w-56 shrink-0 flex flex-col border-r border-slate-200 bg-white"
      >
        <div className="border-b border-slate-100 p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-brand">Edu XHS</div>
          <div className="mt-0.5 font-semibold text-slate-900">运营工作台</div>
          <p className="mt-1 text-xs text-slate-500">应用 v1.2</p>
        </div>
        <nav className="flex-1 space-y-0.5 p-2" id="nav">
          <NavItem to="/dash">总览</NavItem>
          <NavItem to="/copy">文案管理</NavItem>
          <NavItem to="/images">图片管理</NavItem>
          <NavItem to="/templates">模版管理</NavItem>
          <NavItem to="/notes">笔记管理</NavItem>
          <NavItem to="/workbench">工作台</NavItem>
        </nav>
        <div className="border-t border-slate-100 p-3 text-xs leading-relaxed text-slate-400">
          v1.2：<strong className="text-slate-600">工作台</strong>（<code className="text-slate-500">/workbench</code>
          ）。不含合规扫描、素材归档、自动发布（协作未实现）
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white/80 px-6 backdrop-blur">
          <h1 className="truncate text-lg font-semibold text-slate-900">{pageTitle}</h1>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              id="btn-save-draft"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              onClick={() => window.dispatchEvent(new CustomEvent('xhs:save-draft'))}
            >
              保存草稿
            </button>
            <button
              type="button"
              id="btn-open-template-modal"
              className="rounded-lg bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-dark"
              onClick={() => setTplModalOpen(true)}
            >
              选择模版
            </button>
            <Link
              to="/templates"
              className="hidden rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 sm:inline-block"
            >
              模版库
            </Link>
          </div>
        </header>

        <div className="flex-1 overflow-auto p-6">
          <Outlet />
        </div>
      </main>

      <TemplatePickerModal
        open={tplModalOpen}
        onClose={() => setTplModalOpen(false)}
        onPicked={(name) => showToast(`已选择模版：${name}`)}
      />

      {toast ? (
        <div
          id="toast"
          className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg"
          role="status"
        >
          {toast}
        </div>
      ) : null}
    </div>
  )
}
