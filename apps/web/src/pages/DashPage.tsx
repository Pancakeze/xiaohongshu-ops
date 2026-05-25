import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet, type OverviewPayload } from '../lib/api'

function formatViewsCn(views: number | null, metricsPending: boolean): string {
  if (metricsPending && views == null) return '待补数'
  if (views == null) return '—'
  if (views >= 10_000) {
    const w = views / 10_000
    const s = w >= 10 ? w.toFixed(0) : w.toFixed(1).replace(/\.0$/, '')
    return `${s}万`
  }
  return views.toLocaleString('zh-CN')
}

function formatThresholdLabel(n: number): string {
  if (n >= 10_000 && n % 10_000 === 0) return `${n / 10_000}万`
  return n.toLocaleString('zh-CN')
}

export function DashPage() {
  const [data, setData] = useState<OverviewPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setErr(null)
      const o = await apiGet<OverviewPayload>('/api/overview')
      setData(o)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (err) {
    return (
      <div className="mx-auto max-w-6xl" data-feature="dash">
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-6xl text-sm text-slate-500" data-feature="dash">
        加载中…
      </div>
    )
  }

  const th = data.quality_views_threshold

  return (
    <div className="mx-auto max-w-6xl" data-feature="dash">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">已发布笔记数</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">{data.published_notes_total}</div>
          <div className="mt-2 text-xs text-slate-400">账号累计</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">本周发布数量</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">{data.published_this_week_count}</div>
          <div className="mt-2 text-xs text-emerald-600">按创作中心发布时间 · Mon–Sun</div>
          {data.week_range_mon_sun_label ? (
            <div className="mt-1 text-xs text-slate-400">（{data.week_range_mon_sun_label}）</div>
          ) : null}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">{`优质笔记（曝光 > ${formatThresholdLabel(th)}，无曝光则观看）`}</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">{data.quality_notes_count}</div>
          <div className="mt-2 text-xs text-slate-400">可配置阈值（服务端 OVERVIEW_QUALITY_VIEWS_THRESHOLD）</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">待发布草稿</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">{data.pending_composed_drafts_count}</div>
          <div className="mt-2 text-xs text-slate-400">在「笔记管理」组合生成（ComposedDraft 全量）</div>
        </div>
      </div>

      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 font-semibold text-slate-900">按浏览量 Top 5 笔记（含小红书链接）</h2>
        {data.published_notes_total === 0 ? (
          <p className="text-sm leading-relaxed text-slate-500">
            暂无已发布笔记数据。请到
            <Link to="/notes" className="mx-1 font-medium text-brand hover:underline">
              笔记管理
            </Link>
            同步或导入后再查看 Top 5。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">标题 / 摘要</th>
                  <th className="py-2 pr-3">浏览量</th>
                  <th className="py-2">笔记链接</th>
                </tr>
              </thead>
              <tbody className="text-slate-700">
                {data.top_notes.map((row, i) => (
                  <tr key={row.id} className={i < data.top_notes.length - 1 ? 'border-b border-slate-100' : ''}>
                    <td className="py-2.5 pr-3">{i + 1}</td>
                    <td className="max-w-[220px] py-2.5 pr-3">
                      <div className="truncate font-medium">{row.title}</div>
                      {row.summary ? <div className="truncate text-xs text-slate-400">{row.summary}</div> : null}
                    </td>
                    <td className="py-2.5 pr-3 font-medium">{formatViewsCn(row.views, row.metrics_pending)}</td>
                    <td className="py-2.5">
                      {row.official_url ? (
                        <a
                          href={row.official_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-brand hover:underline"
                        >
                          {row.official_url.length > 48 ? `${row.official_url.slice(0, 48)}…` : row.official_url}
                        </a>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 font-semibold text-slate-900">建议动线</h2>
        <ol className="list-inside list-decimal space-y-2 text-sm text-slate-600">
          <li>「文案管理」：选模版 + 竞品链接或粘贴文案 → 生成并版本管理</li>
          <li>「图片管理」：图稿池入池；Google 聊天式生图后手动入池，并与「工作台」联动</li>
          <li>
            「笔记管理」：同步历史笔记；将文案与所选图稿<strong>组合</strong>为新草稿
          </li>
          <li>
            「模版管理」+「<strong>工作台</strong>」精修 → 手机预览
          </li>
        </ol>
      </div>
    </div>
  )
}
