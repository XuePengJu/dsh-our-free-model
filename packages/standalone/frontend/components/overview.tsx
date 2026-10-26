import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowRight, Boxes, Check, CircleCheck, Copy, KeyRound, Layers3, MoreHorizontal, Network, RefreshCw, RotateCcw, Terminal, Zap } from 'lucide-react'
import { Badge, Button, Card, ConfirmDialog, DropdownMenu } from './ui'
import { resolveEndpointBase } from '../endpoint-origin'
import { loadSavedModelId, resolveDefaultModelId, saveClientModelId } from '../client-config'
import { useAutoRefreshSpin } from '../use-auto-refresh-spin'
import { createEntranceTracker, prefersReducedMotionNow, useEntranceDiff, useNumberTween } from '../use-raf-tween'
import '../usage.css'
import type { Host, Snapshot } from '../types'

const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value)
const compact = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : number(value)

/**
 * 「见过哪些失败行」的记忆必须跨挂载存活 —— 从概览切到用量页再切回来时，
 * 列表 DOM 全新建出来，组件内的 ref 早就没了，用模块级单例才能不重放。
 */
const failureEntrance = createEntranceTracker(200)

/**
 * 柱子首挂载从 0 长上来。
 *
 * 返回 `false` 时调用方给 `height: 0`，返回 `true` 后给真实高度，
 * 中间那一下由 CSS 的 `transition: height` 补出来（概览页 7 天柱两条都走 height 过渡，
 * **不用** `scaleY`：柱顶有圆角，`scaleY` 会把圆角压成椭圆）。
 *
 * 为什么要**两次** rAF：单次 rAF 里 `setState` 会被 React 在同一帧提交完，
 * 浏览器一次 `height: 0` 都没画出来，过渡自然无从谈起。第一次 rAF 落在「0 已经上屏」
 * 之后，第二次才切真实值。
 *
 * `prefers-reduced-motion` 下直接返回已长好，不做过渡。
 */
function useBarsGrown(): boolean {
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    if (prefersReducedMotionNow()) { setGrown(true); return }
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setGrown(true))
    })
    return () => {
      cancelAnimationFrame(outer)
      if (inner) cancelAnimationFrame(inner)
    }
  }, [])
  return grown
}

/**
 * 「累计 Token」指标的主数字：走 `useNumberTween`（ref + 直写 textContent，不 setState）。
 *
 * 单独拆一个子组件而不是把 hook 挂在 `Overview` 上，是因为 `Overview` 每 5 秒会因
 * 轮询重渲染；hook 挂在子组件里，补间状态就只跟这一个数字绑定。
 * 首屏先把终值画出来（无 JS / 冻结时也是对的），挂载后再从 0 补到终值 ——
 * 与用量页 KPI 卡（`usage-kpis.tsx` 的 `KpiValue`）同一套行为。
 */
function MetricNumber({ value }: { value: number }) {
  const ref = useRef<HTMLElement>(null)
  useNumberTween(ref, value, { from: 0, format: compact })
  return <strong ref={ref}>{compact(value)}</strong>
}

export function Overview({ summary, stats, host }: Snapshot & { host: Host }) {
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [modelCopied, setModelCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const rotateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); if (rotateTimer.current) clearTimeout(rotateTimer.current) }, [])
  // 默认接入模型：初始解析一次（记住上次选择，否则优先模型组，再退首个可接入模型）。
  const [modelId, setModelId] = useState(() => resolveDefaultModelId(summary.catalog, loadSavedModelId()))
  const routableModels = summary.catalog.filter(model => model.routable)

  /**
   * 4 张指标卡。只给「累计 Token」留 `numeric`（老板只批了这一张做补间）；
   * 其余三张仍渲染预格式化的 `value` 字符串，行为与改动前完全一致。
   */
  const metricRows: Array<{ name: string; value?: string; numeric?: number; icon: typeof Boxes; detail: string }> = [
    { name: '可接入模型', value: number(summary.catalog.filter(model => model.routable).length), icon: Boxes, detail: '当前公开的模型清单' },
    { name: '用户回合', value: number(stats.turns), icon: Layers3, detail: `${number(stats.requests)} 次物理请求` },
    // `value` 是给人看的 `1,713.3M`，补间需要裸数字，所以再留一份 `numeric`。
    { name: '累计 Token', numeric: stats.grand.input + stats.grand.output, icon: Zap, detail: `输入 ${compact(stats.grand.input)} · 输出 ${compact(stats.grand.output)}` },
    { name: '已恢复回合', value: number(stats.recoveredTurns), icon: Activity, detail: `最终未完成 ${number(stats.failedTurns)} 回合` },
  ]
  const today = new Date()
  const days = Array.from({ length: 7 }, (_, index) => {
    const at = new Date(today); at.setDate(at.getDate() - 6 + index)
    const id = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    return { id, value: stats.days.find(row => row.day === id)?.total ?? 0 }
  })
  const total = days.reduce((sum, row) => sum + row.value, 0)
  const max = Math.max(1, ...days.map(row => row.value))
  // 7 天柱的入场：首帧 0 高度，双 rAF 后交给 CSS 的 height 过渡长到真实高度。
  const barsGrown = useBarsGrown()
  // `useMemo` 不是为了省算力，是为了**身份稳定**：`[...x].reverse().filter()` 每次渲染
  // 都是新数组，差分入场会被当成「一批全新的行」，行就每次渲染都重播。
  const failures = useMemo(
    () => [...stats.samples].reverse().filter(row => row.ok === false).slice(0, 4),
    [stats.samples],
  )
  // 失败行 key：`${at}:${model}`。原来用 `${at}-${index}`，index 会随列表长度漂移，
  // 同一条失败请求换个下标就被当成新行 → 差分失效。
  const freshFailures = useEntranceDiff(failures, row => `${row.at}:${row.model ?? ''}`, failureEntrance)
  const sources = [
    { name: '匿名与 Kilo', sub: '无需账号的免费模型', icon: Zap, count: summary.catalog.filter(row => row.channel === 'anonymous' || row.channel === 'kilo').length, page: 'models' as const },
    { name: '账号池', sub: '13 个供应商，独立账号池', icon: Network, count: summary.catalog.filter(row => !['anonymous', 'kilo', 'eac'].includes(row.channel)).length, page: 'channels' as const },
  ]

  const copyEndpoint = () => {
    void host.copy(`${resolveEndpointBase(summary.baseUrl)}/v1`).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
    }).catch(host.error)
  }

  // 复制真实 API Key：Key 只在点击瞬间取出，界面常驻的是打码文本。
  const copyApiKey = () => {
    void host.getApiKey().then(key => host.copy(key))
      .catch(() => host.error(new Error('API Key 获取失败，请先登录管理台')))
  }

  // 复制当前选中的默认模型 ID（与 copyEndpoint 同款 2 秒反馈）。
  const copyModelId = () => {
    void host.copy(modelId).then(() => {
      setModelCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setModelCopied(false), 2000)
    }).catch(host.error)
  }

  // 重置 API Key：原「API 接入」页的唯一有效功能收编到快速接入卡。
  // 成功反馈走同款 2 秒气泡（4 秒，给「更新客户端」留阅读时间），失败走全局错误条。
  const [rotated, setRotated] = useState(false)
  const rotateKey = () => {
    void host.rotateKey().then(() => {
      setRotated(true)
      if (rotateTimer.current) clearTimeout(rotateTimer.current)
      rotateTimer.current = setTimeout(() => setRotated(false), 4000)
    }).catch(host.error)
  }
  // 两段式确认（与模型组删除同款）：第一次点菜单项只武装（文案变「确认重置」），
  // 再点才弹确认层；菜单因任何路径关闭时解除武装。
  const [rotateMenuOpen, setRotateMenuOpen] = useState(false)
  const [rotateArmed, setRotateArmed] = useState(false)
  const [confirmingRotate, setConfirmingRotate] = useState(false)
  // 自动轮询动效：共享 hook（最短转 600ms，肉眼可见），只转圈不禁用不换文案。
  const autoRefreshing = useAutoRefreshSpin()

  return <div className="dashboard ov-dashboard" data-testid="overview-ready">
    {/* ===== Hero：标题 + 7 天用量 + 快速接入 ===== */}
    <section className="ov-hero">
      <div className="ov-hero-main">
        {/* 规则 1：标题居左、操作居右同排；移动端按钮换行到标题下方。 */}
        <div className="ov-hero-head">
          <div className="ov-hero-title">
            <div className="heading-eyebrow">WORKSPACE / OVERVIEW</div>
            <h1>工作空间概览</h1>
            <p className="ov-hero-sub">查看你的模型连接与运行情况 · 数据仅保存在本机</p>
          </div>
          <div className="ov-hero-actions">
            <Button variant="outline" disabled={refreshing} onClick={() => {
              setRefreshing(true); void host.refresh().catch(host.error).finally(() => setRefreshing(false))
            }}><RefreshCw size={15} className={refreshing || autoRefreshing ? 'spinning' : ''} />{refreshing ? '正在更新' : '更新状态'}</Button>
          </div>
        </div>
        <div className="ov-hero-spark" role="img" aria-label={`最近七天 Token 用量：${days.map(day => `${day.id} ${number(day.value)}`).join('；')}`}>
          <div className="ov-spark-head"><span>最近 7 天用量</span><strong>{compact(total)} <small>Token</small></strong></div>
          <div className="ov-spark-bars">
            {days.map(day => <div className="ov-spark-col" key={day.id} title={`${day.id} · ${number(day.value)} Token`}>
              <div className={`ov-spark-bar ${day.value === 0 ? 'zero' : ''}`}
                style={{ height: barsGrown ? `${Math.max(4, day.value / max * 100)}%` : '0%' }} />
              <span>{day.id.slice(5).replace('-', '/')}</span>
            </div>)}
          </div>
        </div>
      </div>

      <Card className="ov-hero-connect">
        {/* 卡头右侧 ⋯ 菜单：收纳低频危险操作「重置 API Key」（全站唯一入口）。 */}
        <div className="ov-connect-head"><div className="quick-icon ov-quick-icon"><Terminal size={19} /></div>
          <div><h2>快速接入</h2><p>OpenAI 兼容 · 即取即用</p></div>
          <DropdownMenu className="ov-head-menu" triggerLabel="接入密钥操作" icon={<MoreHorizontal size={16} />}
            open={rotateMenuOpen} onOpenChange={setRotateMenuOpen}
            onClose={() => setRotateArmed(false)}
            items={[{ key: 'rotate', label: rotateArmed ? '确认重置' : '重置 API Key', icon: <RotateCcw size={14} />,
              danger: true, keepOpen: true, title: '重置后旧密钥立即失效，所有客户端需要更新',
              onSelect: () => { if (rotateArmed) { setRotateArmed(false); setRotateMenuOpen(false); setConfirmingRotate(true) } else setRotateArmed(true) } }]} />
        </div>
        <div className="ov-connect-fields">
          <label>API BASE URL</label>
          <div className="quick-endpoint ov-endpoint"><code>{resolveEndpointBase(summary.baseUrl)}/v1</code>
            <Button variant="ghost" aria-label="复制 API 地址" onClick={copyEndpoint} title="复制 API 地址" className={copied ? 'ov-copied' : ''}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </Button>
          </div>
          {copied && <span className="copy-feedback" role="status">地址已复制</span>}
          <label>API KEY</label>
          <div className="quick-endpoint ov-endpoint ov-access-key"><code>ofm-****</code>
            <Button variant="ghost" aria-label="复制 API Key" onClick={copyApiKey} title="复制 API Key"><KeyRound size={16} /></Button>
          </div>
          {rotated && <span className="copy-feedback" role="status">API Key 已重置，请同步更新客户端密钥</span>}
          <label>默认模型</label>
          <div className="ov-access-model-row">
            <select className="ov-access-select" value={modelId} aria-label="默认接入模型"
              onChange={event => { const id = event.target.value; setModelId(id); saveClientModelId(id) }}>
              {routableModels.length ? routableModels.map(row =>
                <option key={row.id} value={row.id}>{row.channel === 'combo' ? row.id : row.name}</option>)
                : <option disabled value="">无可接入模型</option>}
            </select>
            <Button variant="ghost" aria-label="复制模型 ID" title="复制模型 ID" disabled={!modelId}
              onClick={copyModelId} className={modelCopied ? 'ov-copied' : ''}>
              {modelCopied ? <Check size={16} /> : <Copy size={16} />}
            </Button>
          </div>
        </div>
        <div className="connection-footnote"><span className={`status-dot ${summary.settings.enabled ? '' : 'paused'}`} />{summary.settings.enabled ? '推理服务已启用 · Bearer 鉴权' : '推理服务已暂停'}</div>
      </Card>
    </section>

    {/* ===== 指标 ===== */}
    <div className="dashboard-metrics">{metricRows.map(metric => <Card className="dashboard-metric ov-metric" key={metric.name}>
      <div><span>{metric.name}</span><div className="ov-metric-icon"><metric.icon size={17} /></div></div>
      {metric.numeric === undefined ? <strong>{metric.value}</strong> : <MetricNumber value={metric.numeric} />}
      <p>{metric.detail}</p>
    </Card>)}</div>

    {/* ===== 主区：Token 用量 + 运行检查 ===== */}
    <div className="dashboard-main-grid">
      <Card className="usage-panel ov-chart-panel">
        {/* 规则 2：卡片操作上移标题行右侧，底部只留口径说明。 */}
        <div className="card-heading"><div><h2>Token 用量</h2><p>最近 7 天的输入与输出</p></div>
          <button className="heading-action" onClick={() => host.navigate('usage')}>查看全部用量 <ArrowRight size={14} /></button></div>
        <div className="usage-total ov-chart-total">{compact(total)} <span>Token</span></div>
        <div className="dashboard-chart ov-chart" role="img" aria-label={`最近七天 Token 用量：${days.map(day => `${day.id} ${day.value}`).join('；')}`}>
          <div className="chart-grid-lines"><span /><span /><span /><span /></div>
          {days.map(day => <div className="dashboard-chart-column ov-chart-col" key={day.id} title={`${day.id} · ${number(day.value)} Token`}>
            <div className={`dashboard-chart-bar ${day.value === 0 ? 'zero' : ''}`}
              style={{ height: barsGrown ? `${Math.max(2, day.value / max * 80)}%` : '0%' }} />
            <span>{day.id.slice(5).replace('-', '/')}</span>
          </div>)}
          {total === 0 && <div className="chart-empty ov-chart-empty"><Activity size={22} /><span>还没有调用记录</span><small>接入客户端后，用量会显示在这里</small></div>}
        </div>
        <div className="card-foot"><span>按实际请求记录统计</span></div>
      </Card>

      <Card className="ov-failures">
        <div className="card-heading"><div><h2>运行检查</h2><p>服务与最近的失败请求</p></div>
          <div className="card-heading-actions">
            <Badge tone={failures.length ? 'warning' : 'success'}>{failures.length ? '有失败记录' : '暂无失败记录'}</Badge>
            <button className="heading-action" onClick={() => host.navigate('settings')}>服务设置 <ArrowRight size={14} /></button>
          </div></div>
        <div className="runtime-check"><CircleCheck size={17} /><span>渠道模块</span><strong>{summary.channels.state === 'ready' ? '已就绪' : summary.channels.state === 'failed' ? '加载失败' : '初始化中'}</strong></div>
        <div className="runtime-check"><RefreshCw size={17} /><span>模型自动刷新</span><strong>{summary.automaticRefresh ? `每 ${summary.settings.probeIntervalMinutes} 分钟` : '已暂停'}</strong></div>
        {failures.length ? <div className="failure-list ov-failure-list">{failures.map(row =>
          <div key={`${row.at}:${row.model ?? ''}`}
            className={`ov-failure-row${freshFailures.has(`${row.at}:${row.model ?? ''}`) ? ' is-new' : ''}`}>
            <span>{row.model ?? '未知模型'}</span>
            <small>{row.at ? new Date(row.at).toLocaleTimeString('zh-CN') : '时间未知'} · 请求未完成</small>
          </div>)}</div>
          : <div className="runtime-empty ov-runtime-empty"><CircleCheck size={18} /><span>最近的请求样本中没有失败记录</span></div>}
        <div className="card-foot"><span title={summary.dataDir}>数据仅保存在本机独立目录</span></div>
      </Card>
    </div>

    {/* ===== 底部：模型来源（横排） ===== */}
    <div className="ov-bottom">
      <Card className="ov-sources">
        <div className="card-heading"><div><h2>模型来源</h2><p>所有渠道，共用一个接入地址</p></div>
          <Badge>{sources.reduce((sum, source) => sum + source.count, 0)} 个来源</Badge></div>
        <div className="source-list ov-source-list">{sources.map((source, index) => <button className="source-row ov-source-row" key={source.name} onClick={() => host.navigate(source.page)}
          style={{ animationDelay: `${index * 60}ms` }}>
          <span className="source-icon"><source.icon size={18} /></span>
          <span><strong>{source.name}</strong><small>{source.sub}</small></span>
          <Badge>{source.count} 个模型</Badge><ArrowRight size={14} />
        </button>)}</div>
      </Card>
    </div>

    {/* 重置 API Key 确认层：危险操作最后一道闸，确认后才真正调 /key/rotate。 */}
    <ConfirmDialog open={confirmingRotate} danger title="重置 API Key"
      body="重置后旧 API Key 会立即失效，所有客户端都需要更换新密钥。确认继续吗？"
      confirmText="确认重置" onCancel={() => setConfirmingRotate(false)}
      onConfirm={() => { setConfirmingRotate(false); rotateKey() }} />
  </div>
}
