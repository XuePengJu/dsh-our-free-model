/**
 * `?mock=1` 时的**唯一**数据源（原型对齐用的假数据）。
 *
 * 批次 2 之后本文件只保留两样东西：
 *   1. 常量段（`PROVIDERS` / `MOCK_*`）与 `mockUsageView()`；
 *   2. 什么都没有 —— 类型契约已整段迁到 `types.ts`，组件一律 `from '../../types'`。
 *
 * 保留它的理由：真实数据目录为空时（新装 / 刚清空），页面上几乎所有区块都是空态，
 * 无法核对设计与动效。`?mock=1` 让评审和截图回到「有数据」的那一版。
 *
 * 数值口径与原型 `docs/design/usage-routing.html` 的种子数据一致，方便与设计稿逐格对照。
 *
 * ⚠️ mock 必须**覆盖全部区块**：只要有一块还在读真实 `/stats`，空数据目录下就会开天窗
 *    （批次 1 首轮就是这样漏了「按模型统计」和口径明细条）。新增区块时记得同步加字段。
 * ⚠️ mock 的聚合必须走**和真实数据同一套纯函数**（`usage-data.mjs`）：均值用 Σ/份数，
 *    缺失给 `undefined` 而不是 0。假数据也要守真口径，否则「看起来对」的假象会掩盖真 bug。
 */
import type { UsageModel } from '../../types'
import { PROVIDER_META } from '../../usage-data.mjs'

import type {
  AttemptOutcome,
  BusinessStrip,
  CandidateLabelKind,
  CandidateState,
  ChainSummary,
  ChannelModelRow,
  ChannelRow,
  ChannelTableMode,
  CurrentRequest,
  KpiCard,
  LedgerAccountRow,
  LedgerChannelKind,
  LedgerChannelRow,
  LedgerEntry,
  LedgerModelRow,
  LedgerProviderRow,
  LedgerTotals,
  ProviderMeta,
  RoutingCandidate,
  RoutingSource,
  RoutingTotals,
  StreamRow,
  ThroughputSeries,
  UsageAttempt,
  UsageView,
  Verdict,
  VerdictBullet,
} from '../../types'

// ===========================================================================
// 常量段（`?mock=1` 专用）
// ===========================================================================

/**
 * 渠道品牌色与简称（与原型 `CH` 表一致）。
 *
 * ⚠️ 从 `usage-data.mjs#PROVIDER_META` 复制而不是各写一份：真实数据的明细表也读那张表，
 * 两处不一致会出现「mock 里 TRAE 是青色、真实数据里变成紫色」这种对着截图查不出的怪现象。
 */
export const PROVIDERS: Record<string, ProviderMeta> = { ...PROVIDER_META }

/** 空小计：缺失字段一律用 undefined 表示「无样本」，不用 0。 */
export const emptyTotals = (): LedgerTotals => ({
  requests: 0,
  reportedRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  errors: 0,
})

/** 确定性 PRNG（mulberry32）：保证每次加载的假数据一致，方便与设计稿逐格比对。 */
const makeRandom = (seed: number) => {
  let state = seed >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** 近 60 分钟的双轴序列：均值回归式随机游走，比独立随机更像真实峰谷。 */
const buildThroughput = (now: number): ThroughputSeries => {
  const random = makeRandom(20261026)
  const bucketMs = 60_000
  const buckets = 60
  const tokens: number[] = []
  const tps: (number | null)[] = []
  let base = 2200
  for (let index = 0; index < buckets; index += 1) {
    base += (2600 - base) * 0.22 + (random() - 0.5) * 880
    base = clamp(base, 900, 6200)
    tokens.push(Math.round(base))
    // 末尾 3 个桶留空：模拟「刚过去的一分钟还没结算」，图上表现为断线而不是 0
    if (index >= buckets - 3) { tps.push(null); continue }
    const value = 54 + Math.sin(index * 0.55) * 10 + (random() - 0.5) * 8 + base / 1100
    tps.push(Number(clamp(value, 32, 94).toFixed(1)))
  }
  return { tokens, tps, bucketMs, from: now - buckets * bucketMs }
}

/** 明细表源数据（一行 = 渠道 + 账号 + 主力模型），与原型 ROWS 一致。 */
interface MockLedgerRow {
  provider: string
  account: string
  model: string
  requests: number
  errors: number
  tps: number
  ttftMs: number
  inputTokens: number
  outputTokens: number
  cacheHit: number
}

const MOCK_LEDGER_ROWS: MockLedgerRow[] = [
  { provider: 'trae', account: '#2 Peng', model: 'deepseek-v3.2-exp', requests: 486, errors: 1, tps: 78.4, ttftMs: 642, inputTokens: 284_000, outputTokens: 61_000, cacheHit: 0.41 },
  { provider: 'qoder', account: '#1 主号', model: 'qwen3-max', requests: 312, errors: 2, tps: 61.8, ttftMs: 781, inputTokens: 196_000, outputTokens: 42_000, cacheHit: 0.33 },
  { provider: 'minimax', account: '#1 签到号', model: 'MiniMax-M3', requests: 184, errors: 0, tps: 44.2, ttftMs: 938, inputTokens: 121_000, outputTokens: 28_000, cacheHit: 0.28 },
  { provider: 'zcode', account: '#1 默认', model: 'glm-4.6', requests: 143, errors: 0, tps: 70.6, ttftMs: 521, inputTokens: 92_000, outputTokens: 19_000, cacheHit: 0.52 },
  { provider: 'buddy', account: '#3 备用', model: 'kimi-k2-0905', requests: 88, errors: 0, tps: 55.1, ttftMs: 874, inputTokens: 61_000, outputTokens: 12_000, cacheHit: 0.19 },
  { provider: 'codearts', account: '#1 免费额度', model: 'deepseek-v3.2', requests: 27, errors: 0, tps: 66.3, ttftMs: 708, inputTokens: 18_000, outputTokens: 3_400, cacheHit: 0.24 },
]

const rowTotals = (row: MockLedgerRow): LedgerTotals => ({
  ...emptyTotals(),
  requests: row.requests,
  reportedRequests: row.requests - row.errors,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheReadTokens: Math.round(row.inputTokens * row.cacheHit),
  reasoningTokens: Math.round(row.outputTokens * 0.12),
  errors: row.errors,
  avgTtftMs: row.ttftMs,
  avgTps: row.tps,
})

const sumTotals = (rows: LedgerTotals[]): LedgerTotals => {
  const base = emptyTotals()
  for (const row of rows) {
    base.requests += row.requests
    base.reportedRequests += row.reportedRequests
    base.inputTokens += row.inputTokens
    base.outputTokens += row.outputTokens
    base.cacheReadTokens += row.cacheReadTokens
    base.cacheWriteTokens += row.cacheWriteTokens
    base.reasoningTokens += row.reasoningTokens
    base.errors += row.errors
  }
  // 均值一律「Σ / 份数」。这里把 `requests` 当份数**只对 mock 成立**：
  // `MockLedgerRow` 是手写的单渠道汇总，它假设每一笔请求都可测（都有 tps / ttft），
  // 所以「请求数」就是「样本数」，加权即精确、不是估算。
  // ⚠️ 真实数据不能这么算：落盘日聚合只给了均值，没给 Σ 与份数，
  //   按请求数加权就是估算 —— 真数据的速率一律由 `usage-data.mjs#ledgerRateIndex`
  //   从明细样本重算，绝不回填历史均值。
  let ttftSum = 0
  let ttftWeight = 0
  let tpsSum = 0
  let tpsWeight = 0
  for (const row of rows) {
    if (row.avgTtftMs != null && row.requests > 0) {
      ttftSum += row.avgTtftMs * row.requests
      ttftWeight += row.requests
    }
    if (row.avgTps != null && row.requests > 0) {
      tpsSum += row.avgTps * row.requests
      tpsWeight += row.requests
    }
  }
  if (ttftWeight > 0) base.avgTtftMs = Math.round(ttftSum / ttftWeight)
  if (tpsWeight > 0) base.avgTps = Math.round((tpsSum / tpsWeight) * 10) / 10
  return base
}

const buildChannelRows = (): ChannelRow[] => {
  const total = MOCK_LEDGER_ROWS.reduce((sum, row) => sum + row.requests, 0)
  return MOCK_LEDGER_ROWS.map(row => {
    const meta = PROVIDERS[row.provider]
    return {
      key: `gateway|${row.provider}`,
      channelName: '网关',
      provider: row.provider,
      providerName: meta.name,
      providerShort: meta.short,
      accent: meta.accent,
      accounts: 1,
      topAccount: row.account,
      topModel: row.model,
      topModels: [row.model],
      totals: rowTotals(row),
      share: total > 0 ? Math.round((row.requests / total) * 100) : 0,
    }
  })
}

const buildModelRows = (channelRows: ChannelRow[]): ChannelModelRow[] => {
  const total = channelRows.reduce((sum, row) => sum + row.totals.requests, 0)
  return channelRows.map(row => ({
    key: `model|${row.topModel}`,
    model: row.topModel,
    providers: 1,
    accounts: row.accounts,
    totals: row.totals,
    share: total > 0 ? Math.round((row.totals.requests / total) * 100) : 0,
  }))
}

/** 降级链清单（与原型 CHAINS 一致）。 */
const buildChains = (): ChainSummary[] => {
  const member = (provider: string, model: string) => {
    const meta = PROVIDERS[provider]
    return { provider, providerName: meta.name, providerShort: meta.short, accent: meta.accent, model }
  }
  return [
    {
      comboId: 'combo:auto',
      name: 'auto',
      strategy: 'fallback',
      strategyLabel: '顺序降级',
      members: [
        member('trae', 'deepseek-v3.2-exp'),
        member('qoder', 'qwen3-max'),
        member('minimax', 'MiniMax-M3'),
        member('zcode', 'glm-4.6'),
        member('buddy', 'kimi-k2-0905'),
        member('codearts', 'deepseek-v3.2'),
      ],
      requests: 1084,
      reroutes: 24,
    },
    {
      comboId: 'combo:deepseek',
      name: 'deepseek',
      strategy: 'fallback',
      strategyLabel: '顺序降级',
      members: [
        member('trae', 'deepseek-v3.2-exp'),
        member('codearts', 'deepseek-v3.2'),
        member('buddy', 'deepseek-v3.1'),
      ],
      requests: 132,
      reroutes: 3,
    },
    {
      comboId: 'direct',
      name: '直连',
      strategy: 'direct',
      strategyLabel: '直连',
      members: [member('qoder', 'qwen3-max')],
      requests: 24,
      reroutes: 0,
    },
  ]
}

/** 实时请求流（最新在前）。 */
const buildStream = (now: number): StreamRow[] => {
  const seed: { provider: string; model: string; account: string; tps: number; ttftMs: number; tokens: number; failed?: boolean }[] = [
    { provider: 'qoder', model: 'qwen3-max', account: '#1 主号', tps: 63.2, ttftMs: 790, tokens: 8_421 },
    { provider: 'trae', model: 'deepseek-v3.2-exp', account: '#2 Peng', tps: 81.5, ttftMs: 628, tokens: 12_480 },
    { provider: 'minimax', model: 'MiniMax-M3', account: '#1 签到号', tps: 41.8, ttftMs: 960, tokens: 4_120 },
    { provider: 'zcode', model: 'glm-4.6', account: '#1 默认', tps: 69.4, ttftMs: 540, tokens: 6_930 },
    { provider: 'trae', model: 'deepseek-v3.2-exp', account: '#2 Peng', tps: 77.1, ttftMs: 671, tokens: 9_842 },
    { provider: 'codearts', model: 'deepseek-v3.2', account: '#1 免费额度', tps: 0, ttftMs: 1_120, tokens: 0, failed: true },
  ]
  return seed.map((row, index) => {
    const meta = PROVIDERS[row.provider]
    return {
      key: `${now - index * 19_000}:${row.model}:${index}`,
      at: now - index * 19_000,
      // 与真实路径一致：`provider` 放**展示名**（真实数据的明细也走 providerMeta）。
      provider: meta.name,
      providerShort: meta.short,
      accent: meta.accent,
      model: row.model,
      account: row.account,
      tps: row.failed ? undefined : row.tps,
      ttftMs: row.ttftMs,
      tokens: row.tokens,
      failed: row.failed === true,
      reason: row.failed ? '429 · 稍后重试，已切下一个候选' : undefined,
    }
  })
}

/**
 * 候选链（`combo:auto`，第 1 条正在回答、第 2 条曾 429 被跳过）。
 *
 * 标签**全中文**（与产品其它文案一致：「待命」「失败」「已跳过」都是中文，
 * 不能中英混搭；原型用英文 `answering…` / `pending`，落地统一译成中文）。
 * 未到达的候选显示该渠道的平均速度，用于横向比较。
 */
const buildCandidates = (): RoutingCandidate[] => {
  const averageTps: Record<string, number> = {}
  for (const row of MOCK_LEDGER_ROWS) averageTps[row.provider] = row.tps
  const rows: {
    provider: string
    model: string
    account: string
    state: CandidateState
    tps?: number
    labelKind: CandidateLabelKind
    label: string
    reason?: string
  }[] = [
    { provider: 'trae', model: 'deepseek-v3.2-exp', account: '#2 Peng', state: 'active', tps: 53.5, labelKind: 'answering', label: '应答中…' },
    { provider: 'qoder', model: 'qwen3-max', account: '#1 主号', state: 'skipped', labelKind: 'rate', label: '429 · 稍后重试', reason: '429 · 稍后重试' },
    { provider: 'minimax', model: 'MiniMax-M3', account: '#1 签到号', state: 'pending', tps: averageTps.minimax, labelKind: 'idle', label: '待命' },
    { provider: 'zcode', model: 'glm-4.6', account: '#1 默认', state: 'pending', tps: averageTps.zcode, labelKind: 'idle', label: '待命' },
    { provider: 'buddy', model: 'kimi-k2-0905', account: '#3 备用', state: 'pending', tps: averageTps.buddy, labelKind: 'idle', label: '待命' },
    { provider: 'codearts', model: 'deepseek-v3.2', account: '#1 免费额度', state: 'pending', tps: averageTps.codearts, labelKind: 'idle', label: '待命' },
  ]
  return rows.map(row => {
    const meta = PROVIDERS[row.provider]
    return {
      candidateId: `${row.provider}/${row.model}`,
      provider: row.provider,
      providerName: meta.name,
      providerShort: meta.short,
      accent: meta.accent,
      model: row.model,
      account: row.account,
      state: row.state,
      tps: row.tps,
      labelKind: row.labelKind,
      label: row.label,
      reason: row.reason,
    }
  })
}

/** 「按模型统计」表的原始行：模型 id 用 `provider/model`（与真实 /stats 的下发形态一致）。 */
const buildUsageModels = (): UsageModel[] =>
  MOCK_LEDGER_ROWS.map(row => ({
    model: `${row.provider}/${row.model}`,
    name: row.model,
    calls: row.requests,
    turns: Math.round(row.requests * 0.82),
    input: row.inputTokens,
    output: row.outputTokens,
    reasoning: Math.round(row.outputTokens * 0.12),
    cacheRead: Math.round(row.inputTokens * row.cacheHit),
    failed: row.errors,
    failedTurns: row.errors,
    recoveredTurns: row.errors > 0 ? 1 : 0,
    avgTtftMs: row.ttftMs,
    tps: row.tps,
  }))

/** 造一份完整的看板数据；`?mock=1` 时 `usage.tsx` 直接用它。 */
export function mockUsageView(now = Date.now()): UsageView {
  const channelRows = buildChannelRows()
  const ledgerTotals = sumTotals(channelRows.map(row => row.totals))
  const inputTokens = 420_000 + 26_000
  const outputTokens = 96_000 + 4_200
  const cacheReadTokens = 214_000
  const requests = 1_240
  const errors = 3
  const reroutes = 27
  const recoveredTurns = 3
  const avgTps = 68.4
  const avgTtftMs = 690
  const cacheRate = Math.round((cacheReadTokens / Math.max(1, inputTokens + cacheReadTokens)) * 100)
  const throughput = buildThroughput(now)
  const sparkTokens = throughput.tokens.slice(-26)
  const sparkTps = throughput.tps.map(value => value ?? 0).slice(-26)

  return {
    providerMeta: PROVIDERS,
    sources: [
      { id: 'claude-code', name: 'Claude Code', accent: '#7c8dff', sub: 'combo:auto · 并行 2 路', active: true },
      { id: 'codex-cli', name: 'Codex CLI', accent: '#3ec9a0', sub: 'combo:deepseek', active: false },
      { id: 'direct', name: '直连调用', accent: '#f0b45e', sub: 'trae/deepseek-v3.2-exp', active: false },
    ],
    activeChainId: 'combo:auto',
    candidates: buildCandidates(),
    current: {
      id: '#8842',
      hit: 'TRAE · #2 Peng',
      ttftMs: 631,
      tps: 53.5,
      outputTokens: 742,
      failed: false,
    },
    verdict: {
      text: 'TRAE 接管了这次请求。',
      bullets: [
        { color: '#7c8dff', text: 'Claude Code 请求 combo:auto' },
        { color: '#3ec9a0', text: 'TRAE 排第 1，直接命中' },
        { color: '#f0b45e', text: 'Qoder 曾 429，被跳过' },
      ],
    },
    routingTotals: { requests: 42, reroutes: 3, errors: 0 },
    attempts: [],
    kpis: [
      {
        key: 'tokens',
        label: '今日 Token',
        value: inputTokens + outputTokens,
        delta: { text: '+8%' },
        hint: `输入 420K · 输出 96K · 累计 1.9M`,
        spark: sparkTokens,
        accent: 'accent',
      },
      {
        key: 'speed',
        label: '平均生成速度',
        value: avgTps,
        decimals: 1,
        unit: 'tok/s',
        hint: `首字 ${Math.round(avgTtftMs)} ms`,
        spark: sparkTps,
        accent: 'ok',
      },
      {
        key: 'cache',
        label: '缓存命中',
        value: cacheRate,
        unit: '%',
        hint: `命中 ${Math.round(cacheReadTokens / 1000)}K tok`,
        spark: sparkTokens.map(value => value * 0.44),
        accent: 'violet',
      },
      {
        key: 'requests',
        label: '请求',
        value: requests,
        delta: { text: '99.8%' },
        hint: `失败 ${errors} · 重试 ${reroutes}`,
        spark: sparkTps.map((value, index) => value * 0.6 + index),
        accent: 'cyan',
      },
      {
        key: 'reroutes',
        label: '降级接管',
        value: reroutes,
        unit: '次',
        hint: `占请求 ${Math.round((reroutes / Math.max(1, requests)) * 100)}% · 含断流恢复，不含候选跳过`,
        spark: sparkTps.map((_value, index) => Math.floor(index / 4)),
        accent: 'warn',
      },
    ],
    throughput,
    stream: buildStream(now),
    ledgerTotals: { ...ledgerTotals, requests, inputTokens, outputTokens, cacheReadTokens, errors, avgTps, avgTtftMs },
    channelRows,
    modelRows: buildModelRows(channelRows),
    chains: buildChains(),
    // 口径明细条：与 KPI 同源，保证同屏数字自洽
    strip: {
      turns: 1_084,
      requests,
      input: inputTokens,
      output: outputTokens,
      failedTurns: 2,
      recoveredTurns,
      failedRequests: errors + 2,
      windowTotal: throughput.tokens.reduce((sum, value) => sum + value, 0),
    },
    usageModels: buildUsageModels(),
  }
}

/** 供外部（批次 2 的摊平函数）复用的口径工具，避免两处各写一份。 */
export const usageViewHelpers = { emptyTotals, sumTotals, clamp }
