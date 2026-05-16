import { useCallback, useEffect, useRef, useState } from 'react'
import {
  apiGet,
  apiPost,
  type CompetitorAnalysisHistoryRow,
  type CompetitorAnalyzeXhsPayload,
  type XhsTopNote,
} from '../lib/api'
import {
  getBridgeExtensionId,
  tryExtensionScrapeExploreRelated,
  tryExtensionScrapeProfileNotes,
  tryExtensionScrapeTopNotes,
} from '../lib/publishBridge'
import { formatYmdHmDashKeyword } from '../lib/formatDate'

type Props = {
  entryId: string
  /** 供「重新生成」作为对标正文的参考来源 */
  onBenchmarkDraftChange: (draft: { title: string; body: string } | null) => void
}

/**
 * 小红书站内：经发布助手抓取 Top10 → 分析 → 落库；对标草稿回传父组件用于「重新生成」。
 */
export function CopyCompetitorPanel({ entryId, onBenchmarkDraftChange }: Props) {
  const [mode, setMode] = useState<'xhs' | 'profile' | 'note'>('xhs')
  const [keyword, setKeyword] = useState('')
  const [profileUrl, setProfileUrl] = useState('')
  const [noteUrl, setNoteUrl] = useState('')
  const [goal, setGoal] = useState('')
  const [audience, setAudience] = useState('')
  const [product, setProduct] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<CompetitorAnalyzeXhsPayload | null>(null)
  const [history, setHistory] = useState<CompetitorAnalysisHistoryRow[]>([])
  const [historyPick, setHistoryPick] = useState<string>('')
  const latestRef = useRef<CompetitorAnalyzeXhsPayload | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const rows = await apiGet<CompetitorAnalysisHistoryRow[]>(
        `/api/entries/${entryId}/competitor-analyses?limit=40`,
      )
      setHistory(rows)
    } catch {
      setHistory([])
    }
  }, [entryId])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    latestRef.current = null
    setData(null)
    setHistoryPick('')
    setErr(null)
  }, [entryId])

  useEffect(() => {
    if (!data) return
    const t = (data.generated_title || '').trim()
    const b = (data.generated_body || '').trim()
    if (!t && !b) {
      onBenchmarkDraftChange(null)
      return
    }
    onBenchmarkDraftChange({ title: data.generated_title || '', body: data.generated_body || '' })
  }, [data, onBenchmarkDraftChange])

  const pushAnalyze = useCallback(
    async (body: { keyword: string; items: XhsTopNote[] }) => {
      setErr(null)
      setData(null)
      setHistoryPick('')
      setLoading(true)
      try {
        const res = await apiPost<CompetitorAnalyzeXhsPayload>('/api/competitors/analyze-xhs', {
          keyword: body.keyword,
          items: body.items,
          goal: goal.trim() || null,
          audience: audience.trim() || null,
          product: product.trim() || null,
          entry_id: entryId,
        })
        latestRef.current = res
        setData(res)
        void loadHistory()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [goal, audience, product, entryId, loadHistory],
  )

  const runXhs = useCallback(async () => {
    const kw = keyword.trim()
    if (!kw) {
      setErr('请输入小红书站内搜索关键词')
      return
    }
    const extId = getBridgeExtensionId('')
    if (!extId) {
      setErr('请先在「工作台与发布」填写并保存发布助手编号')
      return
    }
    const scraped = await new Promise<{ keyword: string; items: XhsTopNote[] }>((resolve, reject) => {
      tryExtensionScrapeTopNotes(
        extId,
        kw,
        (r) => {
          if (r.ok) resolve({ keyword: r.keyword, items: r.items as XhsTopNote[] })
          else reject(new Error(r.detail ? `${r.reason}: ${r.detail}` : r.reason))
        },
        { limit: 10 },
      )
    })
    await pushAnalyze(scraped)
  }, [keyword, pushAnalyze])

  const runProfile = useCallback(async () => {
    const u = profileUrl.trim()
    if (!u) {
      setErr('请粘贴小红书用户主页链接（笔记列表页）')
      return
    }
    const extId = getBridgeExtensionId('')
    if (!extId) {
      setErr('请先在「工作台与发布」填写并保存发布助手编号')
      return
    }
    const scraped = await new Promise<{ keyword: string; items: XhsTopNote[] }>((resolve, reject) => {
      tryExtensionScrapeProfileNotes(
        extId,
        u,
        (r) => {
          if (r.ok) resolve({ keyword: r.keyword, items: r.items as XhsTopNote[] })
          else reject(new Error(r.detail ? `${r.reason}: ${r.detail}` : r.reason))
        },
        { limit: 10 },
      )
    })
    await pushAnalyze(scraped)
  }, [profileUrl, pushAnalyze])

  const runNote = useCallback(async () => {
    const u = noteUrl.trim()
    if (!u) {
      setErr('请粘贴一条笔记链接（/explore/...）')
      return
    }
    const extId = getBridgeExtensionId('')
    if (!extId) {
      setErr('请先在「工作台与发布」填写并保存发布助手编号')
      return
    }
    const scraped = await new Promise<{ keyword: string; items: XhsTopNote[] }>((resolve, reject) => {
      tryExtensionScrapeExploreRelated(
        extId,
        u,
        (r) => {
          if (r.ok) resolve({ keyword: r.keyword, items: r.items as XhsTopNote[] })
          else reject(new Error(r.detail ? `${r.reason}: ${r.detail}` : r.reason))
        },
        { limit: 10 },
      )
    })
    await pushAnalyze(scraped)
  }, [noteUrl, pushAnalyze])

  const run = () => {
    setErr(null)
    void (async () => {
      try {
        await (mode === 'xhs' ? runXhs() : mode === 'profile' ? runProfile() : runNote())
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })()
  }

  const payloadFromHistoryRow = useCallback((row: CompetitorAnalysisHistoryRow): CompetitorAnalyzeXhsPayload => {
    return {
      keyword: row.source_keyword,
      top10: row.top10,
      analysis_markdown: row.analysis_markdown,
      generated_title: row.generated_title,
      generated_body: row.generated_body,
    }
  }, [])

  const onHistorySelect = (id: string) => {
    setHistoryPick(id)
    if (!id) return
    if (id === '__latest__') {
      const r = latestRef.current
      if (r) {
        setData(r)
        return
      }
      const newest = history[0]
      if (newest) {
        setData(payloadFromHistoryRow(newest))
        return
      }
      setData(null)
      return
    }
    const row = history.find((h) => h.id === id)
    if (!row) return
    setData(payloadFromHistoryRow(row))
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">竞品参考（站内 Top10 → 分析 → 产出文案）</h2>
            <p className="mt-1 text-xs text-slate-500">
              分析结果会保存到当前条目历史；下方「对标草稿」会在你点击「重新生成」时一并作为参考。
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
            onClick={() => void run()}
            disabled={loading}
          >
            {loading ? '分析中…' : '开始分析'}
          </button>
        </div>

        {err ? <p className="mt-3 text-sm text-rose-700">{err}</p> : null}

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-[12rem] flex-1 text-xs text-slate-500">
            历史记录
            <select
              className="mt-1 w-full max-w-md rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
              value={historyPick}
              onChange={(e) => onHistorySelect(e.target.value)}
            >
              <option value="">— 请选择 —</option>
              <option value="__latest__">最近一次分析（本次会话）</option>
              {history.map((h) => (
                <option key={h.id} value={h.id}>
                  {formatYmdHmDashKeyword(h.created_at, h.source_keyword || '')}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={`rounded-lg border px-3 py-1.5 text-xs ${mode === 'xhs' ? 'border-brand bg-brand-soft text-slate-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            onClick={() => setMode('xhs')}
          >
            站内关键词
          </button>
          <button
            type="button"
            className={`rounded-lg border px-3 py-1.5 text-xs ${mode === 'profile' ? 'border-brand bg-brand-soft text-slate-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            onClick={() => setMode('profile')}
          >
            用户主页笔记列表
          </button>
          <button
            type="button"
            className={`rounded-lg border px-3 py-1.5 text-xs ${mode === 'note' ? 'border-brand bg-brand-soft text-slate-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            onClick={() => setMode('note')}
          >
            单条笔记相关推荐
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          {mode === 'xhs' ? (
            <label className="lg:col-span-2">
              <div className="mb-1 text-xs text-slate-500">小红书站内搜索关键词</div>
              <input
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-brand"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="例如：初一数学 提分 / 英语 背单词…"
              />
              <p className="mt-1 text-xs text-slate-400">将打开或复用搜索页，并整理前 10 条热门笔记作为参考（需已安装发布助手）。</p>
            </label>
          ) : mode === 'profile' ? (
            <label className="lg:col-span-2">
              <div className="mb-1 text-xs text-slate-500">用户主页链接（笔记列表）</div>
              <input
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-brand"
                value={profileUrl}
                onChange={(e) => setProfileUrl(e.target.value)}
                placeholder="https://www.xiaohongshu.com/user/profile/xxxxxxxx"
              />
              <p className="mt-1 text-xs text-slate-400">需已登录小红书 Web；若反爬可能抓空。</p>
            </label>
          ) : (
            <label className="lg:col-span-2">
              <div className="mb-1 text-xs text-slate-500">笔记链接（相关推荐）</div>
              <input
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-brand"
                value={noteUrl}
                onChange={(e) => setNoteUrl(e.target.value)}
                placeholder="https://www.xiaohongshu.com/explore/xxxxxxxx"
              />
              <p className="mt-1 text-xs text-slate-400">打开该笔记页，从页面抓取其它笔记链接 Top10。</p>
            </label>
          )}
          <div className="space-y-3">
            <label>
              <div className="mb-1 text-xs text-slate-500">对标目标（可选）</div>
              <input
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="收藏 / 私信 / 关键词…"
              />
            </label>
            <label>
              <div className="mb-1 text-xs text-slate-500">目标人群（可选）</div>
              <input
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="例如：初一家长…"
              />
            </label>
            <label>
              <div className="mb-1 text-xs text-slate-500">我的产品/服务（可选）</div>
              <textarea
                rows={3}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand"
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                placeholder="一句话说明要卖什么或交付什么结果"
              />
            </label>
          </div>
        </div>
      </div>

      {data ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-slate-900">
              站内 Top10（来源：
              {data.keyword.length > 80 ? `${data.keyword.slice(0, 80)}…` : data.keyword}）
            </h3>
            <div className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto">
              {data.top10.length ? (
                data.top10.map((p, idx) => (
                  <div key={`${p.url}-${idx}`} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-slate-700">
                        #{idx + 1} {p.title.trim().slice(0, 70)}
                      </div>
                      {p.like_text ? (
                        <div className="shrink-0 text-[11px] text-slate-400">点赞数 {p.like_text}</div>
                      ) : null}
                    </div>
                    <div className="mt-1 break-all text-[11px] text-slate-500">{p.url}</div>
                    {p.excerpt?.trim() ? (
                      <div className="mt-2 text-xs text-slate-600">{p.excerpt.trim().slice(0, 140)}</div>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500">未抓到卡片（页面结构或登录态可能不符）。</p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-slate-900">竞品分析（markdown）</h3>
            <pre className="mt-3 max-h-[14rem] overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs leading-relaxed text-slate-800">
              {data.analysis_markdown || '（无）'}
            </pre>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">对标草稿（会参与「重新生成」）</h3>
            <p className="mt-1 text-[11px] text-slate-400">
              点击右侧「重新生成」时，将把此标题与正文作为参考粘贴给模版（须改写，勿照搬）。
            </p>
            <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-3 text-sm font-medium text-slate-900">
              {data.generated_title || '（无标题）'}
            </div>
            <pre className="mt-2 max-h-[12rem] overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs leading-relaxed text-slate-900">
              {data.generated_body || '（无正文）'}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}
