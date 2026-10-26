/**
 * 用量与路由（融合看板）。
 *
 * 本文件**只做编排**：持有 period / 搜索 / 排序 / 分页等页面状态，把数据分发到 7 个子组件。
 * 子组件全部纯展示（唯一例外是 `ChannelTable` 的「按渠道 / 按模型」内部视图状态）。
 *
 * ## 两条独立的数据链路（批次 2）
 *
 * | 区块 | 数据源 | 时钟 |
 * | --- | --- | --- |
 * | KPI 5 张、口径条、按模型统计、吞吐图 | `/stats`（app 层 `loadData`） | 5 秒（全局） |
 * | 明细表、实时请求流、候选链走查 | `/usage/ledger` + `/usage/attempts`（本文件自持） | 6 秒，首延迟 3 秒 |
 *
 * **两条钟刻意错开相位**：`/stats` 在 0s / 5s / 10s… 触发，账本在 3s / 9s / 15s… 触发，
 * 同一瞬间永远不会有两个请求在飞（本机服务是单进程 HTTP，合并峰值能明显减少卡顿感）。
 *
 * 为什么账本不并进 `loadData()`：它要跨到 worker 线程走两个 RPC，是这页最慢的一次往返。
 * 并进整包会让「渠道 worker 挂死」升级成「整张统计页白屏」。账本失败只降级
 * **明细表 + 实时流**两块，上方用量与趋势照常渲染。
 *
 * ## 口径
 *
 * - `/stats` = **业务口径**（用户回合 / 物理请求 / 缓存命中 / 平均速度）；
 * - `/usage/ledger` = **渠道账本口径**（channel → provider → account → model 四级），
 *   内存上限 500 条、重启清空；
 * - RPC 的聚合树**没有时间维度**，所以「今日 / 近 7 天 / 近 30 天」必须由前端按
 *   `utc8DayKey`（UTC+8 日界）重新聚合，见 `usage-data.mjs#ledgerView`。
 *
 * ## 数据开关
 *
 * - `?mock=1` → 用 `components/usage/mock-data.ts` 的常量假数据（覆盖全部区块）；
 * - `?static=1` → 冻结所有动效，等价于静态终态（用于导出稳定截图）。
 *
 * ## 铁律
 *
 * 1. 全页**只有一个 rAF 循环**（`use-raf-tween.ts` 的模块级单例），任何组件都不许自己开；
 * 2. 数字滚动一律 ref + 直写 textContent，**绝不 setState**；
 * 3. 页面隐藏或 `active === false` 时不登记补间（直接落终值），否则切回来会「重放历史」；
 * 4. 空态必须**分类**：①账本从未有记录 ②本档为空 ③读取失败 ④加载中 —— 四句文案各不相同。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, RefreshCw, X } from 'lucide-react'
import { Button } from './components/ui'
import { bucketSamples, latestChainTurn, ledgerView, providerMeta, utc8DayKey, usageModels } from './usage-data.mjs'
import { useAutoRefreshSpin } from './use-auto-refresh-spin'
import { usePrefersReducedMotion, useReveal } from './use-raf-tween'
import { mockUsageView } from './components/usage/mock-data'
import type {
  BusinessStrip,
  ChainSummary,
  ChannelModelRow,
  ChannelRow,
  CurrentRequest,
  KpiCard,
  LedgerTotals,
  ProviderMeta,
  RoutingCandidate,
  RoutingSource,
  RoutingTotals,
  StreamRow,
  ThroughputSeries,
  UsageAttempt,
  UsageLedgerResponse,
  UsageView,
  Verdict,
} from './types'
import { RoutingLive, gatewayPort } from './components/usage/routing-live'
import { UsageKpis } from './components/usage/usage-kpis'
import { ThroughputChart } from './components/usage/throughput-chart'
import { RequestStream } from './components/usage/request-stream'
import { ChannelTable } from './components/usage/channel-table'
import { ChainList } from './components/usage/chain-list'
import { ModelTable } from './components/usage/model-table'
import type { Combo, Host, Stats, Summary, UsageModel, UsagePeriod } from './types'
import './usage.css'
import './usage-routing.css'

const number = (value: number): string => new Intl.NumberFormat('zh-CN').format(value)
const compact = (value: number): string => (value >= 1e6 ? `${Number((value / 1e6).toFixed(1))}M`
  : value >= 1e3 ? `${Number((value / 1e3).toFixed(1))}K` : number(value))

const PERIODS: UsagePeriod[] = ['day', 'week', 'month', 'all']
const PERIOD_LABELS: Record<UsagePeriod, string> = { day: '每日', week: '每周', month: '每月', all: '全部' }
const PERIOD_WORDS: Record<'day' | 'week' | 'month', string> = { day: '今日', week: '本周', month: '本月' }
const PERIOD_STORAGE_KEY = 'dsh-usage-period'

/** 账本时钟：6 秒一轮；首轮延迟 3 秒，与 `/stats` 的 5 秒（相位 0）错开。 */
const LEDGER_INTERVAL_MS = 6000
const LEDGER_FIRST_DELAY_MS = 3000
/** 账本请求的条数：500 = 内存账本全量窗口，保证「今日」重聚合不被截断。 */
const LEDGER_LIMIT = 500
/** 吞吐图的窗口与桶数：近 60 分钟 · 2 分钟一桶。 */
const CHART_WINDOW_MS = 60 * 60 * 1000
const CHART_BUCKETS = 30

const readStoredPeriod = (): UsagePeriod => {
  try {
    const value = localStorage.getItem(PERIOD_STORAGE_KEY)
    return value === 'day' || value === 'week' || value === 'month' || value === 'all' ? value : 'all'
  } catch { return 'all' }
}
const writeStoredPeriod = (value: UsagePeriod): void => {
  try { localStorage.setItem(PERIOD_STORAGE_KEY, value) } catch { /* 存储不可用则忽略，不阻塞视图 */ }
}

/** 读取 URL 开关；`?mock=1` / `?static=1`。SPA 内部导航不会重置 search，一次读取即可。 */
const readFlags = (): { mock: boolean; frozen: boolean } => {
  try {
    const params = new URLSearchParams(window.location.search)
    return { mock: params.get('mock') === '1', frozen: params.get('static') === '1' }
  } catch {
    return { mock: false, frozen: false }
  }
}

/** 从模型 id 派生 provider（`qoder/qwen3-max` → `qoder`；`combo:auto` 无 provider）。 */
const providerOf = (model?: string): string => {
  if (!model) return ''
  const cut = model.indexOf('/')
  return cut > 0 ? model.slice(0, cut) : ''
}

const shortDay = (value: string): string => value.slice(5).replace('-', '/')

/** 渠道账本状态机：`loading`（首屏）/ `ready` / `error`（可能带着上一次的成功快照）。 */
interface LedgerState {
  status: 'loading' | 'ready' | 'error'
  data: UsageLedgerResponse | null
  error: string
}

/** 把 `request()` 抛出的异常翻译成人话（三种常见失败各说一句）。 */
const ledgerErrorText = (reason: unknown): string => {
  const status = (reason as { status?: number })?.status
  if (status === 503) return '渠道服务未连接，明细暂不可用'
  if (status === 502) return '渠道账本读取失败（worker 无响应）'
  if (status === 401) return '登录已失效，请重新登录'
  if (reason instanceof Error) {
    if (reason.name === 'TimeoutError') return '渠道账本读取超时'
    if (reason instanceof TypeError && /fetch/i.test(reason.message)) return '无法连接本地服务'
    return reason.message
  }
  return '渠道账本读取失败'
}

/**
 * 模型组（combo）→ 降级链清单的一行。
 *
 * 只做**展示映射**，不改任何模型组语义：策略文案、成员顺序都照配置原样。
 * 唯一的排序动作是「启用的排在前面」（`Array.sort` 稳定，同状态保持原有顺序）——
 * hero 的候选链取第一条，应该是一条真的在用的链，而不是先建后停用的那条。
 */
function buildChains(combos: Combo[]): ChainSummary[] {
  const STRATEGY_LABELS: Record<string, string> = { fallback: '顺序降级', 'round-robin': '轮询', direct: '直连' }
  return [...combos]
    .sort((a, b) => Number(b.enabled === true) - Number(a.enabled === true))
    .map(combo => ({
      comboId: combo.id,
      name: combo.name,
      strategy: combo.strategy,
      strategyLabel: STRATEGY_LABELS[combo.strategy] ?? combo.strategy,
      members: (combo.models ?? []).map(model => {
        const provider = providerOf(model)
        const meta = providerMeta(provider)
        return { provider, providerName: meta.name, providerShort: meta.short, accent: meta.accent, model }
      }),
    }))
}

/**
 * 候选链（hero 右侧）：来自**当前模型组的配置** + 最近一次真实走查（B 档 attempts）。
 *
 * 状态映射（`turn` 为 null 时全员 `pending`，与未走过时一致）：
 * - `hit` → `done`/「已应答」。速度给 `undefined`（显示 `—`）：`tps` 只存在于单模型
 *   解码窗口内，走查记录里没有，拿渠道均值冒充单次实测是硬伤；本次真实速度看实时流。
 * - `skipped` → `skipped` + 原因原文；限流类原因给 `rate` 标签色，其余 `skip`。
 * - `aborted` → `failed`/「已中止」。⚠️ 它很**少见**：用户主动中断流式会被
 *   `runSingle` 报成可 advance 的 `stream_cut` 而记成 `skipped`；只有登录墙、
 *   恢复预算耗尽这类不可续的收尾才是 `aborted`，绝不当主信号用。
 * - 没出现在回合里的候选（含序号对不上又 id 对不上的）→ `pending`/「待命」+ 渠道均值。
 */
function buildCandidates(
  chain: ChainSummary | undefined,
  avgTpsOf: (provider: string) => number | undefined,
  turn: { turnAt: number; rows: UsageAttempt[] } | null,
): RoutingCandidate[] {
  if (chain === undefined) return []
  const shortLabel = (reason: string): string => (reason.length > 24 ? `${reason.slice(0, 24)}…` : reason)
  return chain.members.map((member, position) => {
    const base = {
      candidateId: `${chain.comboId}:${member.model}`,
      provider: member.provider,
      providerName: member.providerName,
      providerShort: member.providerShort,
      accent: member.accent,
      model: member.model,
      account: '按账号池分配',
      tps: avgTpsOf(member.provider),
    }
    // 序号是主键（组合链顺序即候选顺序）；id 相等作兜底，都对不上就当没走过。
    const row = turn?.rows.find(item => item.index === position) ?? turn?.rows.find(item => item.candidateId === member.model)
    if (row === undefined) {
      return { ...base, state: 'pending' as const, labelKind: 'idle' as const, label: '待命' }
    }
    if (row.outcome === 'hit') {
      // `done` 行不给 tps：isIdleSpeed 只认 pending/probing/tps==null，塞均值会被画成实测值
      return { ...base, tps: undefined, state: 'done' as const, labelKind: 'answered' as const, label: '已应答' }
    }
    if (row.outcome === 'aborted') {
      return { ...base, state: 'failed' as const, labelKind: 'skip' as const, label: '已中止', reason: row.reason }
    }
    const rate = /429|rate|quota|限流|too many/i.test(row.reason)
    return {
      ...base,
      state: 'skipped' as const,
      labelKind: rate ? 'rate' as const : 'skip' as const,
      label: row.reason === '' ? '已跳过' : shortLabel(row.reason),
      reason: row.reason,
    }
  })
}

/**
 * hero 左列的「来源卡」。
 *
 * ⚠️ **永不为空**：批次 2 首版这里传 `[]`，`.r-src-col` 保留宽度却渲染 0 个节点，
 * 第一屏空一大块，看起来像渲染失败。现在至少有一张「本机网关」卡 —— 它描述的是
 * 事实（这个页面就是从本机这个端口发出去的），不是占位。
 *
 * 第二张卡只在「今日真有账本数据」时出现：今日 token 最多的那条渠道。
 * 两张卡的 `active` 都跟随「当前是否有请求在处理」，不硬编码 true。
 */
export function buildSources(
  busy: boolean,
  version: string,
  topChannel: ChannelRow | undefined,
  todayTokens: number,
): RoutingSource[] {
  const sources: RoutingSource[] = [{
    id: 'local-gateway',
    name: '本机网关',
    // 与原型一致用青色系；深色主题下 `--cp-cyan` 由令牌接管。
    accent: 'var(--cp-cyan, #38bdb8)',
    sub: `127.0.0.1:${gatewayPort()} · our-free-model${version === '' ? '' : ` v${version}`}`,
    active: busy,
  }]
  if (topChannel !== undefined && todayTokens > 0) {
    sources.push({
      id: `today:${topChannel.key}`,
      // 只用渠道展示名（`WorkBuddy 国际版`）：来源列固定 180px，加「今日主用 ·」
      // 前缀会把这一行顶出卡片（`.r-nm` 里的裸文本节点没法省略号截断）。
      name: topChannel.providerName || topChannel.provider || topChannel.channelName,
      accent: topChannel.accent,
      sub: `今日 ${topChannel.share}% · ${compact(todayTokens)} tok`,
      active: false,
    })
  }
  return sources
}

/**
 * 用 `/stats` 的真实口径拼出同一套 ViewModel（账本区块由调用方填）。
 *
 * 缺的维度（渠道账本、路由候选、逐条 token）留空，由各区块显示自己的空态——
 * 这样页面**永远不会白屏**，也不会用假数据冒充真数据。
 *
 * @param stats `/stats` 快照
 * @param period 当前档位
 * @param now 图表锚点（毫秒时间戳）：桶对齐、窗口起点都以它为准
 */
function buildStatsView(stats: Stats, period: UsagePeriod, now: number): UsageView {
  const view = stats.periods?.[period]
  // 旧后端降级：periods 缺失时回退累计口径（stats.models / stats.grand），不白屏。
  const metrics = view?.metrics ?? {
    turns: stats.turns,
    requests: stats.requests,
    input: stats.grand.input,
    output: stats.grand.output,
    reasoning: stats.grand.reasoning,
    failedTurns: stats.failedTurns,
    recoveredTurns: stats.recoveredTurns,
    failedRequests: stats.requestFailures,
    avgTtftMs: null,
    tps: null,
  }
  const models: UsageModel[] = period === 'all' ? stats.models : (view?.models ?? [])
  const bars = view?.chart?.bars ?? []
  const cacheRead = models.reduce((sum, row) => sum + (row.cacheRead ?? 0), 0)
  const inputWithCache = metrics.input + cacheRead
  const cacheRate = inputWithCache > 0 ? Math.round((cacheRead / inputWithCache) * 100) : 0
  const tokens = metrics.input + metrics.output
  const tokensSpark = bars.slice(-26).map(bar => bar.total)
  // 吞吐图：近 60 分钟按 2 分钟分桶。速度用 ΣdecodeTokens ÷ ΣdecodeMs 重算，
  // 空桶给 null（图上断线），**绝不给 0** —— 0 会画出一条贴底的假折线。
  const buckets = bucketSamples(stats.samples ?? [], { now, windowMs: CHART_WINDOW_MS, buckets: CHART_BUCKETS })
  const throughput: ThroughputSeries = {
    tokens: buckets.tokens,
    tps: buckets.tps,
    bucketMs: buckets.bucketMs,
    from: buckets.from,
  }
  const providerMetaMap: Record<string, ProviderMeta> = {}
  const stream: StreamRow[] = (stats.samples ?? [])
    .slice(-6)
    .reverse()
    .map((sample, index) => {
      const provider = providerOf(sample.model)
      const meta = providerMeta(provider)
      if (provider !== '') providerMetaMap[provider] = meta
      const input = sample.input ?? 0
      const output = sample.output ?? 0
      const total = input + output
      // ⚠️ 模型名要对齐**账本口径**（去掉 provider 前缀）。
      // `/stats.samples` 的 model 是 `workbuddy/deepseek-v4.1-flash`，账本 entry 的
      // 是 `deepseek-v4.1-flash`。不对齐会有两个可见问题：
      //   1. 账本到达的那一刻（约 3s）6 行的 `key` 全变 → 差分入场把它们当成全新行再播一遍；
      //   2. 同一行文字从带前缀变不带前缀，肉眼看到一次文字闪跳。
      // 前缀只有在 `providerOf` 认得出来时才切掉，避免误伤 `deepseek-ai/DeepSeek-V3` 这类真带斜杠的模型名。
      const bareModel = provider === '' ? (sample.model ?? '') : String(sample.model ?? '').slice(provider.length + 1)
      return {
        key: `${sample.at ?? index}:${bareModel}:${index}`,
        at: sample.at ?? now,
        provider: provider === '' ? '未知渠道' : meta.name,
        providerShort: meta.short,
        accent: meta.accent,
        model: bareModel === '' ? '未知模型' : bareModel,
        account: '未归属',
        // 实测值缺失就 undefined（显示 `—`）；服务端已过门槛，客户端不再二次裁剪。
        tps: typeof sample.tps === 'number' && sample.tps > 0 ? sample.tps : undefined,
        ttftMs: typeof sample.ttftMs === 'number' && sample.ttftMs > 0 ? sample.ttftMs : undefined,
        tokens: total > 0 ? total : undefined,
        failed: sample.ok === false,
        reason: sample.error,
      }
    })
  const kpis: KpiCard[] = [
    {
      key: 'tokens',
      label: period === 'all' ? '累计 Token' : `${PERIOD_WORDS[period]} Token`,
      value: tokens,
      // 卡 1 的「输入」来自 `/stats`，它**把缓存命中算进输入**；账本侧（明细表合计行）
      // 单独统计 cacheRead，所以两处数字会差一个数量级（实测 187M vs 1703.2M，
      // 差额恰为 cacheRead 1516.2M，残差 0.0014%）。不说清楚，用户第一眼一定当 bug。
      title: '输入 Token 含缓存命中（cacheRead），账本侧单独统计，故两处数值不同',
      hint: `输入 ${compact(metrics.input)} · 输出 ${compact(metrics.output)} · 累计 ${compact(stats.grand.input + stats.grand.output)}`,
      spark: tokensSpark,
      accent: 'accent',
    },
    {
      key: 'speed',
      label: '平均生成速度',
      value: metrics.tps ?? undefined,
      decimals: 1,
      unit: 'tok/s',
      hint: metrics.avgTtftMs == null ? '首字 — ms' : `首字 ${number(Math.round(metrics.avgTtftMs))} ms`,
      spark: tokensSpark,
      accent: 'ok',
    },
    {
      key: 'cache',
      label: '缓存命中',
      value: cacheRead > 0 ? cacheRate : undefined,
      unit: '%',
      hint: cacheRead > 0 ? `命中 ${compact(cacheRead)} tok` : '暂无缓存命中样本',
      spark: tokensSpark.map(value => value * 0.44),
      accent: 'violet',
    },
    {
      key: 'requests',
      label: '请求',
      value: metrics.requests,
      delta: {
        text: metrics.requests > 0
          ? `${Math.round(((metrics.requests - metrics.failedRequests) / metrics.requests) * 100)}%`
          : '—',
        flat: metrics.requests === 0,
      },
      hint: `失败 ${number(metrics.failedRequests)} · 重试 ${number(Math.max(0, metrics.requests - (metrics.turns ?? 0)))}`,
      spark: tokensSpark.map((value, index) => value * 0.6 + index),
      accent: 'cyan',
    },
    {
      key: 'reroutes',
      label: '降级接管',
      value: metrics.skippedCandidates ?? 0,
      unit: '次',
      // 主数字 = 组合链跳过候选的次数（周期口径，`recordTurn` 按候选序号累计）；
      // 断流恢复是另一个口径（单模型中断后由恢复预算接上），降为副行，不可相加。
      hint: `其中断流恢复 ${number(metrics.recoveredTurns ?? 0)} 次 · 占请求 ${metrics.requests > 0 ? Math.round(((metrics.skippedCandidates ?? 0) / metrics.requests) * 100) : 0}%`,
      title: '「降级接管」= 模型组把前一个候选换掉、改走下一个的次数（本时段）；「断流恢复」= 单个模型中断后由恢复预算接上的回合数。两者口径不同，不可相加。',
      spark: tokensSpark.map((_value, index) => Math.floor(index / 4)),
      accent: 'warn',
    },
  ]
  const ledgerTotals: LedgerTotals = {
    requests: stats.requests,
    reportedRequests: Math.max(0, stats.requests - stats.requestFailures),
    inputTokens: stats.grand.input,
    outputTokens: stats.grand.output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    reasoningTokens: stats.grand.reasoning,
    errors: stats.requestFailures,
    avgTtftMs: metrics.avgTtftMs ?? undefined,
    avgTps: metrics.tps ?? undefined,
  }
  // hero 底部大数字与 KPI 必须同源：都取「候选跳过」（周期口径）。
  const routingTotals: RoutingTotals = {
    requests: metrics.requests,
    reroutes: metrics.skippedCandidates ?? 0,
    errors: metrics.failedRequests,
  }
  const verdict: Verdict = {
    text: (metrics.skippedCandidates ?? 0) > 0
      ? `本时段有 ${number(metrics.skippedCandidates ?? 0)} 次候选被跳过、${number(metrics.recoveredTurns ?? 0)} 次断流恢复。`
      : '本时段没有发生降级接管。',
    bullets: [],
  }
  // 账本区块（明细表 / 实时流 / 候选速度）由 `Usage()` 用 `/usage/ledger` 的结果覆盖；
  // 这里给空数组，保证「账本还没回来」时各区块走自己的空态而不是崩溃。
  const channelRows: ChannelRow[] = []
  const modelRows: ChannelModelRow[] = []
  // 口径明细条：真数据路径下直接取 /stats 的口径，与 KPI 同源
  const strip: BusinessStrip = {
    turns: metrics.turns ?? 0,
    requests: metrics.requests,
    input: metrics.input,
    output: metrics.output,
    failedTurns: metrics.failedTurns ?? 0,
    recoveredTurns: metrics.recoveredTurns ?? 0,
    failedRequests: metrics.failedRequests,
    windowTotal: view?.chart?.total ?? 0,
  }
  return {
    providerMeta: providerMetaMap,
    sources: [],
    activeChainId: '',
    candidates: [],
    current: null,
    verdict,
    routingTotals,
    attempts: [],
    kpis,
    throughput,
    stream,
    ledgerTotals,
    channelRows,
    modelRows,
    chains: [],
    strip,
    usageModels: models,
  }
}

export function Usage({ summary, stats, host, active }: { summary: Summary; stats: Stats; host: Host; active: boolean }) {
  const [period, setPeriod] = useState<UsagePeriod>(() => readStoredPeriod())
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('calls')
  const [page, setPage] = useState(1)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  // 自动轮询动效：数据本体随 app 层 5 秒快照自动更新，这里只负责按钮图标转圈
  // （共享 hook，最短 600ms；「正在更新」与禁用仍只留给手动点击）。
  const autoRefreshing = useAutoRefreshSpin()
  const generation = useRef(0)
  const refreshingRef = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  const flags = useMemo(readFlags, [])
  const reducedMotion = usePrefersReducedMotion()
  const frozen = flags.frozen || reducedMotion

  // ---- 渠道账本（自己的一条钟） ----
  const [ledger, setLedger] = useState<LedgerState>({ status: 'loading', data: null, error: '' })
  const [combos, setCombos] = useState<Combo[]>([])
  // 降级走查环：跟账本同一个 tick 取（只读本地 store，很快）。失败静默清空 ——
  // 它是辅助信息，绝不能进 `setError` 把整页拉红。
  const [attempts, setAttempts] = useState<UsageAttempt[]>([])
  const attemptsInFlight = useRef(false)
  const ledgerGeneration = useRef(0)
  const ledgerInFlight = useRef(false)

  /** 拉一次账本。失败**不抛**：只把状态切成 `error`，保留上一次成功快照。 */
  const loadLedger = useCallback(async (): Promise<void> => {
    // `?mock=1` 不碰真实账本：整套数据来自常量，再发请求既浪费也让截图不稳定。
    if (flags.mock || !activeRef.current || ledgerInFlight.current) return
    const started = ++ledgerGeneration.current
    ledgerInFlight.current = true
    try {
      const data = await host.usageLedger(LEDGER_LIMIT)
      if (started !== ledgerGeneration.current || !activeRef.current) return
      setLedger({ status: 'ready', data, error: '' })
    } catch (reason) {
      if (started !== ledgerGeneration.current) return
      // 保留 `data`：读失败时页面继续显示上一次的成功快照，比整块变空更诚实
      // （下面会用一行提示说明「这是上次的快照」）。
      setLedger(previous => ({ status: 'error', data: previous.data, error: ledgerErrorText(reason) }))
    } finally {
      ledgerInFlight.current = false
    }
  }, [host, flags.mock])

  /** 模型组 → 降级链清单。低频数据：不挂在 6 秒轮询上，只在进入页面与手动刷新时取。 */
  const loadCombos = useCallback(async (): Promise<void> => {
    if (flags.mock || !activeRef.current) return
    try {
      const value = await host.listCombos()
      if (activeRef.current) setCombos(value)
    } catch {
      // 模型组读失败只影响「降级链」这一块，不弹全局错误条：它和用量不是一回事。
      if (activeRef.current) setCombos([])
    }
  }, [host, flags.mock])

  /** 拉一次降级走查环。失败**静默清空**：候选链退回「待命」，绝不惊动页面错误条。 */
  const loadAttempts = useCallback(async (): Promise<void> => {
    if (flags.mock || !activeRef.current || attemptsInFlight.current) return
    attemptsInFlight.current = true
    try {
      const data = await host.usageAttempts()
      if (activeRef.current) setAttempts(Array.isArray(data?.attempts) ? data.attempts : [])
    } catch {
      if (activeRef.current) setAttempts([])
    } finally {
      attemptsInFlight.current = false
    }
  }, [host, flags.mock])

  useEffect(() => {
    if (!active) {
      generation.current++
      ledgerGeneration.current++
      refreshingRef.current = false
      ledgerInFlight.current = false
      attemptsInFlight.current = false
      setRefreshing(false); setMessage(''); setError(''); setAttempts([])
      return
    }
    return () => { generation.current++; ledgerGeneration.current++ }
  }, [active])
  useEffect(() => { setPage(1) }, [period])
  useEffect(() => { writeStoredPeriod(period) }, [period])

  // 账本时钟：首轮延迟 3 秒（与 /stats 的 5 秒错开相位），之后 6 秒一轮。
  // `document.hidden` 时**不发请求**（后台标签页不该压着 worker），但仍保持钟；
  // 一旦回到前台，`visibilitychange` 里立刻补一次，用户切回来看到的是新数据。
  useEffect(() => {
    if (!active || flags.mock) return
    let cancelled = false
    let timer = 0
    const schedule = (delay: number): void => {
      if (cancelled) return
      timer = window.setTimeout(() => { void tick() }, delay)
    }
    const tick = async (): Promise<void> => {
      if (cancelled) return
      // 账本（worker RPC）与走查环（本地 store）并行取；allSettled 保证一个失败
      // 不拖死另一个。await 完成后才排下一轮：慢请求只推迟节奏，不堆积并发。
      if (!document.hidden) await Promise.allSettled([loadLedger(), loadAttempts()])
      schedule(LEDGER_INTERVAL_MS)
    }
    void loadCombos()
    schedule(LEDGER_FIRST_DELAY_MS)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [active, loadLedger, loadCombos, loadAttempts])

  useEffect(() => {
    if (!active) return
    const onVisible = (): void => { if (!document.hidden) void Promise.allSettled([loadLedger(), loadAttempts()]) }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [active, loadLedger, loadAttempts])

  const view = stats.periods?.[period]
  const periodWord = period === 'all' ? '所选时段' : PERIOD_WORDS[period]
  // 图表锚点：只在 /stats 换新（每 5 秒）时更新，切 period / 改搜索不会让图横向抖动。
  const chartAnchor = useMemo(() => Date.now(), [stats])
  const business = useMemo(() => buildStatsView(stats, period, chartAnchor), [stats, period, chartAnchor])

  const mock = useMemo(() => (flags.mock ? mockUsageView() : null), [flags.mock])

  // 账本 → 摊平后的三块（小计 / 明细表 / 实时流）。切档纯本地重算，不发请求。
  //
  // ⚠️ 两条数据链**必须分开喂**（批次 2 修订）：
  // - 计数与 Token 走 `history`（落盘日聚合、重启保留、无 500 条上限）；
  // - 速率走 `snapshot.entries`（内存明细环，最多 500 条）。
  // 首版把两边都压在 `snapshot` 上，「全部」档只算了最近 500 条（少 34 倍）。
  const ledgerNow = ledger.data?.generatedAt ?? 0
  const history = ledger.data?.history ?? null
  const entries = ledger.data?.snapshot?.entries ?? null
  const blocks = useMemo(
    () => ledgerView(history, entries, { range: period, now: ledgerNow, streamLimit: 6 }),
    [history, entries, period, ledgerNow],
  )
  // 「今日」档单独算一次：hero 的「今日主用渠道」卡要用（与主视图无关，切档不重算）。
  const todayBlocks = useMemo(
    () => ledgerView(history, entries, { range: 'day', now: ledgerNow, streamLimit: 0 }),
    [history, entries, ledgerNow],
  )

  const chains = useMemo(() => buildChains(combos), [combos])
  const activeChain = chains[0]
  /** provider → 账本平均 tok/s（只用于未到达候选的横向比较，`is-idle` 灰小字）。 */
  const avgTpsOf = useCallback((provider: string): number | undefined => {
    for (const row of blocks.accountRows) {
      if (row.provider === provider) return row.totals.avgTps
    }
    return undefined
  }, [blocks.accountRows])

  // 数据源：`?mock=1` 用常量假数据（覆盖**全部区块**，否则空数据目录下会开天窗），
  // 否则「/stats 业务口径 + /usage/ledger 账本口径」拼出同一套 ViewModel。
  // 最近一次走查回合（按 turnAt 精确分组，不猜）。memo 保持引用稳定，
  // 否则 data 的 useMemo 每轮轮询都会把整棵 ViewModel 重算一遍。
  const turn = useMemo(
    () => latestChainTurn(attempts, { chainId: activeChain?.comboId ?? '' }),
    [attempts, activeChain],
  )

  const data: UsageView = useMemo(() => {
    if (mock !== null) return mock
    const hasLedger = ledger.data !== null
    const candidates = buildCandidates(activeChain, avgTpsOf, turn)
    const busy = business.current !== null
      || candidates.some(candidate => candidate.state === 'active' || candidate.state === 'probing')
    // 今日主用渠道：`todayBlocks.accountRows` 已按 token 降序，第一条即最大者。
    const topChannel = todayBlocks.accountRows[0] as ChannelRow | undefined
    const todayTokens = todayBlocks.totals.inputTokens + todayBlocks.totals.outputTokens
    // 判决要点：周期口径的文字来自 buildStatsView，这里把「最近一个回合」里
    // 真实跳过的候选补成彩色要点（没有回合就不加，不拿周期数字冒充单次走查）。
    const bullets = turn === null ? business.verdict.bullets : turn.rows
      .filter(row => row.outcome === 'skipped' && row.reason !== '')
      .map(row => ({
        color: /429|rate|quota|限流|too many/i.test(row.reason) ? 'var(--r-warn, #f0b45e)' : 'var(--r-bad, #e5484d)',
        text: `${row.chainName || row.chainId} · ${row.candidateId}：${row.reason}，已跳过`,
      }))
    return {
      ...business,
      verdict: { ...business.verdict, bullets },
      // 账本还没回来时，实时流退回 `/stats` 的样本（同一份数据源，不会说谎）。
      stream: hasLedger ? blocks.streamRows : business.stream,
      ledgerTotals: hasLedger ? blocks.totals : business.ledgerTotals,
      channelRows: hasLedger ? blocks.accountRows : [],
      modelRows: hasLedger ? blocks.modelRows : [],
      chains,
      sources: buildSources(busy, summary?.version ?? '', topChannel, todayTokens),
      activeChainId: activeChain?.comboId ?? '',
      candidates,
      attempts: turn?.rows ?? [],
    }
  }, [mock, business, blocks, chains, activeChain, avgTpsOf, ledger.data, todayBlocks, summary, turn])

  // 「按模型统计」仍由 usage-data.mjs 的 usageModels() 统一筛选/排序/分页（口径不重写）。
  // mock 模式下数据源换成 mock 的模型行，避免这一块仍读真实 stats 而变成空态。
  const modelSource: UsageModel[] = mock !== null
    ? data.usageModels
    : period === 'all' ? stats.models : (view?.models ?? [])
  const models: { total: number; pages: number; page: number; rows: UsageModel[] } =
    usageModels(modelSource, { search, sort, page })
  useEffect(() => { if (page !== models.page) setPage(models.page) }, [page, models.page])
  const turnsUnavailable = mock !== null ? false : view?.turnsAvailable === false
  const modelTotal = mock !== null
    ? data.usageModels.length
    : period === 'all' ? stats.models.length : (view?.models?.length ?? 0)

  // 入场揭示：首屏播一次，切 period 不重放（与原型「reveal 只播一次」一致）。
  // frozen 时直接置为已揭示，避免「CSS 已归零但元素还停在 opacity:0」。
  const revealHero = useReveal(true, { frozen })
  const revealKpis = useReveal(true, { delay: 60, frozen })
  const revealPanels = useReveal(true, { delay: 120, frozen })
  const revealTail = useReveal(true, { delay: 180, frozen })

  const refresh = async (): Promise<void> => {
    if (refreshingRef.current || !activeRef.current) return
    const started = ++generation.current
    const isCurrent = (): boolean => started === generation.current && activeRef.current
    refreshingRef.current = true
    setRefreshing(true); setMessage(''); setError('')
    try {
      // 账本与模型组各自兜错：它们失败不该把「统计已更新」变成一句红字。
      const [statsResult] = await Promise.allSettled([host.refresh(), loadLedger(), loadCombos(), loadAttempts()])
      if (statsResult.status === 'rejected') throw statsResult.reason
      if (isCurrent()) setMessage('统计已更新')
    } catch (reason) {
      if (isCurrent()) {
        setError(reason instanceof Error ? (reason.name === 'TimeoutError' ? '刷新超时，请重试。'
          : reason instanceof TypeError && /fetch/i.test(reason.message) ? '无法连接本地服务，请确认服务正在运行后重试。'
            : reason.message) : '统计刷新失败，请重试。')
      }
    } finally {
      if (isCurrent()) { refreshingRef.current = false; setRefreshing(false) }
    }
  }

  if (!active) return null

  const shortPeriodLabel = view?.bounds
    ? view.bounds.period === 'day' ? `今日 · ${shortDay(view.bounds.start)}`
      : view.bounds.period === 'all' ? (view.bounds.start ? `自 ${shortDay(view.bounds.start)}` : '累计')
        : `${shortDay(view.bounds.start)}–${shortDay(view.bounds.end)}`
    : ''
  const emptyTitle = search.trim() ? '没有匹配的模型' : period === 'all' ? '还没有模型用量记录' : '所选周期内没有模型活动记录'
  const emptyDesc = search.trim() ? '试试其他名称或 ID，或清空搜索。'
    : period === 'all' ? '接入客户端并发送消息后，模型统计会显示在这里。'
      : `${periodWord}还没有模型调用记录，历史累计仍可在「全部」档查看。`

  // ---- 账本四类状态（文案各不相同，不合并成一句「暂无数据」）----
  const ledgerEntries = ledger.data?.snapshot?.entries?.length ?? 0
  const ledgerLoading = mock === null && ledger.status === 'loading' && ledger.data === null
  const ledgerFailed = mock === null && ledger.status === 'error'
  const ledgerUnavailable = ledgerFailed && ledger.data === null
  const ledgerStale = ledgerFailed && ledger.data !== null
  const chartHasData = data.throughput.tokens.some(value => value > 0) || data.throughput.tps.some(value => value !== null)
  const ledgerEmptyText = ledgerEntries === 0
    // ① 从来没有记录：说清「内存账本、重启清空」这个事实，别让用户以为丢数据了。
    ? '这台机器还没有渠道请求记录。明细账本保存在进程内存里（上限 500 条，重启清空），日聚合仍会保留。'
    // ② 有记录但这一档为空：引导切档，而不是让人以为页面坏了。
    : `${periodWord}没有渠道请求记录；账本里共 ${number(ledgerEntries)} 条历史明细，切到「全部」可查看。`
  const ledgerUnavailableText = `渠道账本读取失败：${ledger.error}。上方用量与趋势不受影响，本区块暂为空。`
  const streamEmptyText = ledgerFailed
    ? '渠道账本读取失败，实时流暂不可用；上方用量与趋势不受影响。'
    : ledgerEmptyText
  const scopeLabel = period === 'all' ? '累计，按渠道聚合' : `${periodWord}，按渠道聚合`
  const totalsLabel = period === 'all' ? '账本合计' : `${periodWord}合计`
  // 速率列的口径提示。三种情况必须区分开，否则同一个表格里的两列会被当成同一口径：
  // - mock：手写假数据，没有「样本窗口」这回事；
  // - 单日档（`rateExact`）：速率是账本落盘日聚合里 vendor 精确 finalize 的全量值，
  //   与 500 条内存上限无关 —— 这时**不能**再说「最近 N 次」，那会低估数据质量；
  // - 多天档：速率来自明细样本，最多 500 条，不是区间全量平均。
  const rateHint = mock !== null
    ? '按渠道实测均值'
    : blocks.rateExact
      ? '当日全量实测均值（账本落盘日聚合，不受 500 条内存上限影响）'
      : `最近 ${number(blocks.windowCount)} 次请求实测，非区间全量平均${blocks.windowSaturated ? '（已达内存上限 500 条）' : ''}`
  // 只有「速率样本撞到上限」时才有必要在表格下方留一行常驻说明（单日档恒为 false）。
  const ledgerSaturated = mock === null && blocks.windowSaturated && data.channelRows.length > 0

  return (
    <div className="usage-browser" data-testid="usage-ready" data-static={frozen ? 'true' : undefined}>
      <header className="dashboard-heading">
        <div>
          <div className="heading-eyebrow">WORKSPACE / ROUTING</div>
          <h1>用量与路由</h1>
          <p>本机用量、渠道账本与实时路由决策同屏，可按日 / 周 / 月 / 累计切换口径。</p>
        </div>
        <div className="r-head-actions">
          <div className="r-seg" role="group" aria-label="统计时间范围">
            {PERIODS.map(key => (
              <button key={key} type="button" aria-pressed={period === key} onClick={() => setPeriod(key)}>
                {PERIOD_LABELS[key]}
              </button>
            ))}
          </div>
          <span className="r-period-label" data-testid="usage-period-label">
            <span className="r-period-label-full">{view?.bounds?.label ?? ''}{view?.bounds?.note ? ` · ${view.bounds.note}` : ''}</span>
            <span className="r-period-label-short">{shortPeriodLabel}</span>
          </span>
          <Button variant="outline" disabled={refreshing} onClick={() => { void refresh() }}>
            <RefreshCw size={15} className={refreshing || autoRefreshing ? 'spinning' : ''} />
            {refreshing ? '正在更新' : '更新统计'}
          </Button>
        </div>
      </header>

      {message && <p className="usage-feedback" role="status">{message}</p>}
      {error && (
        <div className="channel-error" role="alert">
          <CircleAlert size={16} /><span>{error}</span>
          <Button variant="ghost" aria-label="关闭统计错误提示" onClick={() => setError('')}><X size={15} /></Button>
        </div>
      )}

      {/* 业务口径明细条：e2e 依赖 data-metric / usage-request-failures / usage-window-total。
          原型在明细表以外没有口径区，这里用一条薄条承载，同时满足「口径三分必须带文字标注」。
          数值统一取 `data.strip`：mock 模式也随之切换，不会出现「上面有数、这条全 0」的开天窗。 */}
      <div className="r-ledger-strip">
        <span className="r-strip-item">用户回合 <strong data-metric="用户回合">{number(data.strip.turns)}</strong></span>
        <span className="r-strip-item">物理请求 <strong data-metric="物理请求">{number(data.strip.requests)}</strong></span>
        <span className="r-strip-item">输入 Token <strong data-metric="输入 Token">{number(data.strip.input)}</strong></span>
        <span className="r-strip-item">输出 Token <strong data-metric="输出 Token">{number(data.strip.output)}</strong></span>
        <span className="r-strip-item">失败回合 <strong data-metric="失败回合">{number(data.strip.failedTurns)}</strong></span>
        <span className="r-strip-item">恢复回合 <strong data-metric="已恢复回合">{number(data.strip.recoveredTurns)}</strong></span>
        <span className="r-strip-item">物理失败请求 <strong data-testid="usage-request-failures">{number(data.strip.failedRequests)}</strong></span>
        <span className="r-strip-item">所选周期 Token <strong data-testid="usage-window-total">{number(data.strip.windowTotal)}</strong></span>
        <span className="r-strip-note">
          用户回合 / 物理请求来自 /stats；渠道明细按 <b>UTC+8</b> 结算
          {ledgerNow > 0 ? `（今日 = ${utc8DayKey(ledgerNow)}）` : ''}，与日桶口径不同。
        </span>
      </div>

      <div className={`r-reveal${revealHero ? ' is-revealed' : ''}`}>
        <RoutingLive
          sources={data.sources}
          activeChainId={data.activeChainId === '' ? '尚未配置模型组' : data.activeChainId}
          chainStrategyLabel={activeChain?.strategyLabel ?? '顺序降级'}
          candidates={data.candidates}
          current={data.current}
          verdict={data.verdict}
          totals={data.routingTotals}
          attempts={data.attempts}
          turnAt={turn?.turnAt}
          frozen={frozen}
        />
      </div>

      <div className={`r-reveal${revealKpis ? ' is-revealed' : ''}`}>
        <UsageKpis cards={data.kpis} frozen={frozen} />
      </div>

      <div className={`r-split r-reveal${revealPanels ? ' is-revealed' : ''}`}>
        <section className="r-panel">
          <div className="r-panel-head">
            <h3>Token 吞吐与速度</h3>
            <span className="r-panel-sub">近 60 分钟 · 2 分钟桶</span>
            <div className="r-tool">
              <div className="r-legend">
                <span><i style={{ background: 'var(--r-accent)' }} />Token</span>
                <span><i style={{ background: 'var(--r-ok)' }} />tok/s</span>
              </div>
            </div>
          </div>
          <ThroughputChart
            series={data.throughput}
            frozen={frozen}
            emptyText="近 60 分钟还没有 Token 吞吐样本，发一条消息即可看到实时曲线。"
          />
        </section>
        <RequestStream rows={data.stream} limit={6} onOpenLogs={() => host.navigate('logs')} emptyText={streamEmptyText} />
      </div>

      {ledgerStale && (
        <p className="r-ledger-stale" role="status">
          <CircleAlert size={14} aria-hidden="true" />
          <span>渠道账本读取失败（{ledger.error}），下面显示的是上一次成功读取的快照。</span>
        </p>
      )}

      <div className={`r-reveal${revealPanels ? ' is-revealed' : ''}`}>
        <ChannelTable
          channels={data.channelRows}
          models={data.modelRows}
          totals={data.ledgerTotals}
          scopeLabel={scopeLabel}
          totalsLabel={totalsLabel}
          loading={ledgerLoading}
          unavailable={ledgerUnavailable}
          unavailableText={ledgerUnavailableText}
          emptyText={ledgerEmptyText}
          rateHint={rateHint}
        />
      </div>
      {ledgerSaturated && (
        <p className="r-ledger-note" role="note">
          速度与首字来自最近 {number(blocks.windowCount)} 次请求（已达内存上限 500），计数与 Token 为区间全量。
        </p>
      )}

      <div className={`r-reveal${revealTail ? ' is-revealed' : ''}`}>
        <ChainList
          chains={data.chains}
          activeChainId={data.activeChainId}
          onManage={() => host.navigate('combos')}
        />
      </div>
      <div className={`r-reveal${revealTail ? ' is-revealed' : ''}`}>
        <ModelTable
          rows={models.rows}
          total={models.total}
          pages={models.pages}
          page={models.page}
          modelTotal={modelTotal}
          period={period}
          periodWord={periodWord}
          turnsUnavailable={turnsUnavailable}
          search={search}
          sort={sort}
          onSearch={value => { setSearch(value); setPage(1) }}
          onSort={value => { setSort(value); setPage(1) }}
          onPage={next => setPage(next)}
          emptyTitle={emptyTitle}
          emptyDesc={emptyDesc}
        />
      </div>

      {!chartHasData && data.strip.windowTotal === 0 && (
        <p className="usage-window-empty" role="status">
          {period === 'all'
            ? '所选时段没有已记录的 Token 用量，累计统计仍保留历史记录。'
            : `${periodWord}暂无 Token 用量记录，历史累计仍保留。`}
        </p>
      )}
      {(stats.logicalEstimated || stats.requestFailuresEstimated) && (
        <p className="usage-estimated" role="note">
          <CircleAlert size={15} /><span>历史统计含估算：
            {stats.logicalEstimated && '迁移前的用户回合按历史请求估算。'}
            {stats.requestFailuresEstimated && '部分物理失败请求按保留记录估算。'}
            新记录沿用独立的请求与回合统计。</span>
        </p>
      )}
      {view?.note && <p className="usage-estimated" role="note"><CircleAlert size={15} /><span>{view.note}</span></p>}
      <p className="footnote">
        统计只记录用量与性能，不保存提示词和回答。渠道页的「渠道用量」面板已并入本页：账号维度、速度与缓存指标
        迁入上方明细表，逐条全明细在「请求日志」页。渠道明细按 UTC+8 日界结算；未测得的速度与首字显示“—”。
      </p>
    </div>
  )
}
