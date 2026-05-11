import { Link, Outlet, useLocation } from 'react-router-dom'

const ROUTE_TITLES: Record<string, string> = {
  '/workbench': '工作台与发布',
  '/dash': '总览',
  '/copy': '文案生成与管理',
  '/images': '图片生成与管理',
  '/templates': '模版管理',
  '/notes': '笔记管理',
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

export function AppShell() {
  const { pathname } = useLocation()
  const pageTitle = ROUTE_TITLES[pathname] || '运营工作台'

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
          <NavItem to="/copy">文案生成与管理</NavItem>
          <NavItem to="/images">图片生成与管理</NavItem>
          <NavItem to="/templates">模版管理</NavItem>
          <NavItem to="/notes">笔记管理</NavItem>
          <NavItem to="/workbench">工作台与发布</NavItem>
        </nav>
        <div className="border-t border-slate-100 p-3 text-xs leading-relaxed text-slate-400">
          v1.2：<strong className="text-slate-600">工作台与发布</strong>（<code className="text-slate-500">/workbench</code>
          ）。不含合规扫描、素材归档、自动发布（协作未实现）
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white/80 px-6 backdrop-blur">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-lg font-semibold text-slate-900">{pageTitle}</h1>
            <span className="hidden truncate text-xs text-slate-400 sm:inline">
              当前条目：初一数学 · 提分笔记 #042
            </span>
          </div>
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
              className="rounded-lg bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-dark"
              onClick={() => {
                /* 占位：与原型「选择模版」一致，后续接模版弹窗 */
              }}
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
    </div>
  )
}
