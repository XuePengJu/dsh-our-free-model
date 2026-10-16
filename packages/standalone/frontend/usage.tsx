import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowDownToLine, ArrowUpFromLine, ChevronLeft, ChevronRight, CircleAlert, Layers3, RefreshCw, Search, RotateCcw, X } from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import { usageModels } from './usage-data.mjs'
import type { Host, Stats, UsageModel, UsagePeriod } from './types'
import './usage.css'

const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value)
const compact = (value: number) => value >= 1e6 ? `${Number((value / 1e6).toFixed(1))}M`
  : value >= 1e3 ? `${Number((value / 1e3).toFixed(1))}K` : number(value)
const measured = (value?: number | null) => value != null && Number.isFinite(value) ? number(value) : '—'

const PERIODS: UsagePeriod[] = ['day', 'week', 'month', 'all']
const PERIOD_LABELS: Record<UsagePeriod, string> = { day: '每日', week: '每周', month: '每月', all: '全部' }
const PERIOD_WORDS: Record<'day' | 'week' | 'month', string> = { day: '今日', week: '本周', month: '本月' }
const PERIOD_STORAGE_KEY = 'dsh-usage-period'

const readStoredPeriod = (): UsagePeriod => {
  try {
    const value = localStorage.getItem(PERIOD_STORAGE_KEY)
    return value === 'day' || value === 'week' || value === 'month' || value === 'all' ? value : 'all'
  } catch { return 'all' }
}
const writeStoredPeriod = (value: UsagePeriod) => {
  try { localStorage.setItem(PERIOD_STORAGE_KEY, value) } catch { /* 存储不可用则忽略，不阻塞视图 */ }
}

export function Usage({ stats, host, active }: { stats: Stats; host: Host; active: boolean }) {
  const [period, setPeriod] = useState<UsagePeriod>(() => readStoredPeriod())
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('calls')
  const [page, setPage] = useState(1)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const generation = useRef(0)
  const refreshingRef = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    if (!active) {
      generation.current++
      refreshingRef.current = false
      setRefreshing(false); setMessage(''); setError('')
    }
    return () => { generation.current++ }
  }, [active])
  useEffect(() => { setPage(1) }, [period])
  useEffect(() => { writeStoredPeriod(period) }, [period])

  const view = stats.periods?.[period]
  // 旧后端降级：periods 缺失时回退渲染累计口径（stats.models / stats.grand），不白屏。
  const metrics = view?.metrics ?? {
    turns: stats.turns, requests: stats.requests, input: stats.grand.input, output: stats.grand.output,
    reasoning: stats.grand.reasoning, failedTurns: stats.failedTurns, recoveredTurns: stats.recoveredTurns,
    failedRequests: stats.requestFailures, avgTtftMs: null, tps: null,
  }
  const bars = view?.chart?.bars ?? []
  const windowTotal = view?.chart?.total ?? 0
  const max = Math.max(1, ...bars.map(bar => bar.total))
  const models: { total: number; pages: number; page: number; rows: UsageModel[] } =
    usageModels(period === 'all' ? stats.models : (view?.models ?? []), { search, sort, page })
  useEffect(() => { if (page !== models.page) setPage(models.page) }, [page, models.page])
  const hasHistory = stats.requests > 0 || stats.turns > 0 || stats.models.length > 0 || stats.days.length > 0
  const turnsUnavailable = view?.turnsAvailable === false
  const periodWord = period === 'all' ? '所选时段' : PERIOD_WORDS[period]
  const activeModels = view?.models?.length ?? 0
  const modelTotal = period === 'all' ? stats.models.length : activeModels
  const metricCards = [
    { name: '用户回合', value: metrics.turns, detail: '一次用户请求计为一个回合', icon: Layers3 },
    { name: '物理请求', value: metrics.requests, detail: '含重试与断流恢复的追加请求', icon: Activity },
    { name: '输入 Token', value: metrics.input, detail: '以已上报用量为准', icon: ArrowDownToLine },
    { name: '输出 Token', value: metrics.output, detail: '以已上报用量为准', icon: ArrowUpFromLine },
    { name: '失败回合', value: metrics.failedTurns, detail: '最终未完成的用户回合', icon: CircleAlert },
    { name: '已恢复回合', value: metrics.recoveredTurns, detail: '经历恢复后完成的用户回合', icon: RotateCcw },
  ]
  const refresh = async () => {
    if (refreshingRef.current || !activeRef.current) return
    const started = ++generation.current
    const isCurrent = () => started === generation.current && activeRef.current
    refreshingRef.current = true
    setRefreshing(true); setMessage(''); setError('')
    try {
      await host.refresh()
      if (isCurrent()) setMessage('统计已更新')
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.name === 'TimeoutError' ? '刷新超时，请重试。'
        : reason instanceof TypeError && /fetch/i.test(reason.message) ? '无法连接本地服务，请确认服务正在运行后重试。'
        : reason.message : '统计刷新失败，请重试。')
    } finally {
      if (isCurrent()) { refreshingRef.current = false; setRefreshing(false) }
    }
  }
  if (!active) return null
  const trendSubtitle = period === 'all' ? '累计 · 按自然月聚合 · 输入与输出合计'
    : period === 'day' ? '今日 · 最近 7 日对照 · 输入与输出合计'
    : `${PERIOD_WORDS[period]} · 输入与输出合计`
  const chartAriaLabel = `${period === 'all' ? '累计' : PERIOD_LABELS[period]} Token 用量：${bars.map(bar => `${bar.key} ${number(bar.total)}`).join('；')}`
  const chartFoot = period === 'all' ? (view?.chart?.note ?? '') : (view?.bounds?.label ?? '本地自然日')
  const trendEmpty = period === 'all'
    ? '所选时段没有已记录的 Token 用量，累计统计仍保留历史记录。'
    : `${periodWord}暂无 Token 用量记录，历史累计仍保留。`
  const emptyTitle = search.trim() ? '没有匹配的模型' : period === 'all' ? '还没有模型用量记录' : '所选周期内没有模型活动记录'
  const emptyDesc = search.trim() ? '试试其他名称或 ID，或清空搜索。'
    : period === 'all' ? '接入客户端并发送消息后，模型统计会显示在这里。'
    : `${periodWord}还没有模型调用记录，历史累计仍可在「全部」档查看。`
  const shortDay = (value: string) => value.slice(5).replace('-', '/')
  const shortPeriodLabel = view?.bounds
    ? view.bounds.period === 'day' ? `今日 · ${shortDay(view.bounds.start)}`
      : view.bounds.period === 'all' ? (view.bounds.start ? `自 ${shortDay(view.bounds.start)}` : '累计')
      : `${shortDay(view.bounds.start)}–${shortDay(view.bounds.end)}`
    : ''
  return <div className="usage-browser" data-testid="usage-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">WORKSPACE / USAGE</div>
      <h1>用量统计</h1><p>查看本机用量与趋势，可按日 / 周 / 月 / 累计切换口径。</p></div>
      <Button variant="outline" disabled={refreshing} onClick={() => { void refresh() }}>
        <RefreshCw size={15} className={refreshing ? 'spinning' : ''} />{refreshing ? '正在更新' : '更新统计'}
      </Button>
    </header>
    <div className="usage-period-bar">
      <div className="channel-filters usage-period-filters" role="group" aria-label="统计时间范围">
        {PERIODS.map(key => <button key={key} aria-pressed={period === key} onClick={() => setPeriod(key)}>{PERIOD_LABELS[key]}</button>)}
      </div>
      <span className="usage-period-label" data-testid="usage-period-label">
        <span className="usage-period-label-full">{view?.bounds?.label ?? ''}{view?.bounds?.note ? ` · ${view.bounds.note}` : ''}</span>
        <span className="usage-period-label-short">{shortPeriodLabel}</span>
      </span>
    </div>
    {message && <p className="usage-feedback" role="status">{message}</p>}
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span>
      <Button variant="ghost" aria-label="关闭统计错误提示" onClick={() => setError('')}><X size={15} /></Button></div>}
    <div className="usage-metrics">{metricCards.map(metric => <Card className="dashboard-metric ov-metric" key={metric.name}>
      <div><span>{metric.name}</span><div className="ov-metric-icon"><metric.icon size={17} /></div></div>
      <strong title={metric.value == null ? '—' : number(metric.value)} data-metric={metric.name}>
        {metric.value == null ? '—' : metric.name.includes('Token') ? compact(metric.value) : number(metric.value)}
      </strong><p>{metric.detail}</p>
    </Card>)}</div>
    <div className="usage-scope">
      <span>{period === 'all' ? '累计统计 · 覆盖全部历史记录' : '所选周期统计 · 全页口径一致'}</span>
      <span>物理失败请求 <strong data-testid="usage-request-failures">{number(metrics.failedRequests)}</strong></span>
      <span>思考 Token <strong>{number(metrics.reasoning)}</strong></span></div>
    {(stats.logicalEstimated || stats.requestFailuresEstimated) && <p className="usage-estimated" role="note">
      <CircleAlert size={15} /><span>历史统计含估算：
        {stats.logicalEstimated && '迁移前的用户回合按历史请求估算。'}
        {stats.requestFailuresEstimated && '部分物理失败请求按保留记录估算。'}
        新记录沿用独立的请求与回合统计。</span></p>}
    {view?.note && <p className="usage-estimated" role="note"><CircleAlert size={15} /><span>{view.note}</span></p>}
    <Card className="usage-trend">
      <div className="card-heading"><div><h2>{period === 'all' ? '累计 Token 用量' : `${PERIOD_LABELS[period]} Token 用量`}</h2><p>{trendSubtitle}</p></div></div>
      <div className="usage-window-total"><strong data-testid="usage-window-total">{number(windowTotal)}</strong>
        <span>{period === 'all' ? 'Token / 累计' : 'Token / 所选周期'}</span></div>
      <p className="usage-scroll-hint">左右滑动查看完整日期。</p>
      <div className="usage-trend-scroll"><div className="usage-trend-chart" style={{ minWidth: Math.max(7, bars.length) * 35 }}
        role="img" aria-label={chartAriaLabel}>
        {bars.map(bar => <div className={`usage-day${bar.future || bar.partial ? ' muted' : ''}`} key={bar.key} tabIndex={0}
          title={bar.title ?? bar.key} aria-label={bar.title ?? bar.key}>
          <div className="usage-day-track"><div className={`usage-day-bar ${bar.total ? '' : 'zero'}`} style={{ height: `${Math.max(1, bar.total / max * 100)}%` }} /></div>
          <span>{bar.label}</span>
        </div>)}
      </div></div>
      {windowTotal === 0 && <p className="usage-window-empty" role="status">{trendEmpty}</p>}
      <div className="card-foot"><span>{chartFoot}</span><span>未上报的用量不会自动估算为实际 Token</span></div>
    </Card>
    <Card className="usage-model-panel">
      <div className="card-heading"><div><h2>按模型统计</h2>
        <p>{period === 'all' ? '累计记录 · 每页最多 20 个模型' : '所选周期记录 · 每页最多 20 个模型'}</p></div>
        <Badge>{period === 'all' ? `${number(stats.models.length)} 个模型` : `${periodWord} ${number(activeModels)} 个模型有活动`}</Badge></div>
      <div className="usage-model-filters"><div className="usage-model-search"><Search size={16} />
        <Input type="search" aria-label="搜索统计模型" placeholder="搜索模型名称或 ID…" value={search}
          onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>
        <select aria-label="统计模型排序" value={sort} onChange={event => { setSort(event.target.value); setPage(1) }}>
          <option value="calls">物理请求最多</option><option value="tokens">Token 用量最多</option>
          <option value="failedTurns">失败回合最多</option><option value="name">模型名称</option>
        </select>
        {search && <Button variant="ghost" onClick={() => { setSearch(''); setPage(1) }}><X size={14} />清空搜索</Button>}
      </div>
      {models.total ? <><p className="usage-scroll-hint">左右滑动查看完整统计。</p>
      <div className="usage-model-scroll" tabIndex={0} role="region" aria-label="按模型统计，可横向滚动">
        <table className="usage-model-table"><thead><tr>
          <th scope="col">模型 / ID</th><th scope="col">用户回合</th><th scope="col">物理请求</th><th scope="col">输入 Token</th>
          <th scope="col">输出 Token</th><th scope="col">失败回合</th><th scope="col">恢复回合</th>
          <th scope="col">首字延迟{period === 'all' ? <span className="usage-col-hint" title="基于保留期内样本统计，与左侧累计 Token 口径不同。">ⓘ</span> : null}</th>
          <th scope="col">生成速度{period === 'all' ? <span className="usage-col-hint" title="基于保留期内样本统计，与左侧累计 Token 口径不同。">ⓘ</span> : null}</th>
        </tr></thead><tbody>{models.rows.map(model => <tr key={model.model} data-usage-model={model.model}>
          <td><strong>{model.name}</strong><code>{model.model}</code></td><td>{turnsUnavailable ? '—' : number(model.turns)}</td>
          <td>{number(model.calls)}<small>失败 {number(model.failed)}</small></td>
          <td>{number(model.input)}</td><td>{number(model.output)}</td>
          <td>{turnsUnavailable ? '—' : number(model.failedTurns)}</td>
          <td>{turnsUnavailable ? '—' : number(model.recoveredTurns)}</td>
          <td>{measured(model.avgTtftMs)}<small>ms</small></td><td>{measured(model.tps)}<small>Token/s</small></td>
        </tr>)}</tbody></table>
      </div></> : <div className="usage-empty"><Activity size={25} /><h3>{emptyTitle}</h3><p>{emptyDesc}</p></div>}
      <div className="usage-pagination"><span data-testid="usage-model-count">{number(models.total)} / {number(modelTotal)} {period === 'all' ? '个模型' : '个有活动的模型'}</span>
        <span>第 {models.page} / {models.pages} 页</span><Button variant="outline" aria-label="上一页统计模型" disabled={models.page === 1}
          onClick={() => setPage(models.page - 1)}><ChevronLeft size={15} />上一页</Button>
        <Button variant="outline" aria-label="下一页统计模型" disabled={models.page === models.pages}
          onClick={() => setPage(models.page + 1)}>下一页<ChevronRight size={15} /></Button></div>
    </Card>
    <p className="footnote">统计只记录用量与性能，不保存提示词和回答。首字延迟与生成速度基于保留的可测量样本；未测得时显示“—”。</p>
  </div>
}
