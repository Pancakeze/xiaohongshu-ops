export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-slate-500">
          该模块与原型 v1.2 中对应页面一致，为<strong>占位演示</strong>；当前开发优先级为「工作台与发布」。
        </p>
      </div>
    </div>
  )
}
