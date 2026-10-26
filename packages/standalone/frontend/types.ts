export type Page = 'overview' | 'models' | 'combos' | 'usage' | 'logs' | 'channels' | 'settings'
export interface Model {
  id: string
  name: string
  channel: string
  /** 对外可读名（`qwen3.8-max`）：网关 `/v1/models` 广播、也可直接当 model 传。 */
  alias?: string
  routable: boolean
  hiddenByUser?: boolean
  hiddenByGroup?: boolean
  vision?: boolean
  reasoning?: boolean
  contextWindow?: number
  maxOutput?: number
  availabilitySource?: 'listing' | 'probe' | 'manual'
  detail?: string
  probedAt?: number
  latencyMs?: number
  availability?: string
  /** 判定原文（探测/测试失败的具体原因，用于徽章的 title 展开）。 */
  availabilityDetail?: string | null
  ttftMs?: number | null
  disabled?: boolean
}
export interface Combo {
  id: string
  name: string
  models: string[]
  strategy: string
  stickyLimit: number
  enabled: boolean
}
export interface ComboDraft {
  id?: string
  name: string
  models: string[]
  strategy: string
  stickyLimit?: number
  enabled?: boolean
}
export interface ModelTestResult { ok: boolean; text: string; latencyMs: number; ttftMs?: number; persisted?: boolean }
export interface ServiceSettings {
  enabled: boolean
  exposeRegionModels: boolean
  hiddenModelIds: string[]
  hideFreeModels: boolean
  hideEacModels: boolean
  streamRecovery: boolean
  standaloneProbe: boolean
  probeIntervalMinutes: number
  defaultMaxTokens: number
  /** `/v1/models` 对外用哪套名字：both / alias / id（见 src/aliases.js）。 */
  aliasMode?: 'both' | 'alias' | 'id'
}
export interface Summary {
  version: string
  baseUrl: string
  dataDir: string
  networkMode: string
  automaticRefresh: boolean
  catalogSyncedAt: number
  settings: ServiceSettings
  channels: { state: string; error?: string }
  eacAuth?: { local?: boolean; authorized?: boolean; login?: string }
  catalog: Model[]
}
export type UsagePeriod = 'day' | 'week' | 'month' | 'all'
export interface PeriodBounds {
  period: UsagePeriod
  start: string
  end: string
  days: string[]
  label: string
  ongoing: boolean
  note?: string
}
export interface PeriodMetrics {
  turns: number | null
  requests: number
  input: number
  output: number
  reasoning: number
  failedTurns: number | null
  recoveredTurns: number | null
  /** 组合链换掉前一个候选、改走下一个的次数（本档累计）；无回合数据的档位为 null。 */
  skippedCandidates?: number | null
  failedRequests: number
  avgTtftMs: number | null
  tps: number | null
}
export interface ChartBar {
  key: string
  label: string
  total: number
  future?: boolean
  partial?: boolean
  title?: string
}
export interface UsagePeriodView {
  bounds: PeriodBounds
  metrics: PeriodMetrics
  models?: UsageModel[]
  chart: { bars: ChartBar[]; total: number; note: string; granularity: 'day' | 'month' }
  turnsAvailable: boolean
  note?: string
}
export interface Stats {
  requests: number
  requestFailures: number
  requestFailuresEstimated?: boolean
  logicalEstimated?: boolean
  turns: number
  failedTurns: number
  recoveredTurns: number
  days: { day: string; total: number }[]
  grand: {
    input: number; output: number; reasoning: number
    calls?: number; failed?: number; turns?: number; failedTurns?: number; recoveredTurns?: number
  }
  models: UsageModel[]
  /**
   * 逐条调用样本（服务端 `slice(-200)` 的有界环）。
   *
   * ⚠️ 字段口径（`src/store.js#recordUsage`）：
   * - `ttftMs` 不可测时是 **`null`**（不是 0，也不是缺省）；
   * - `tps` 不可测时才缺省，可测时已过服务端的 `MIN_DECODE_MS` / `MAX_CREDIBLE_TPS`
   *   门槛 —— 客户端**不得二次裁剪**，否则与日志页同一条记录的数字会对不上；
   * - `decodeMs` / `decodeTokens` 只在「可测」的行上非 0，双轴图的桶内速度必须
   *   用 **ΣdecodeTokens ÷ ΣdecodeMs** 重算，而不是把 `tps` 再平均。
   */
  samples: {
    model?: string
    ok?: boolean
    error?: string
    at?: number
    ms?: number
    input?: number
    output?: number
    ttftMs?: number | null
    tps?: number
    decodeMs?: number
    decodeTokens?: number
    origin?: string
    truncated?: boolean
    noUsage?: boolean
    attempt?: number
    elapsedMs?: number
    recovered?: boolean
    aborted?: boolean
  }[]
  periods?: Partial<Record<UsagePeriod, UsagePeriodView>>
}
export interface UsageModel {
  model: string
  name: string
  calls: number
  turns: number
  input: number
  output: number
  reasoning: number
  cacheRead?: number
  failed: number
  failedTurns: number
  recoveredTurns: number
  avgTtftMs?: number | null
  tps?: number | null
}
export interface Snapshot { summary: Summary; stats: Stats }
/** 「同步到 WorkBuddy」（模型组全量）的结果计数。 */
export interface WorkbuddySyncResult { added: number; updated: number; removed: number; total: number }
/** 单模型「写入 WorkBuddy」的结果计数。 */
export interface WorkbuddyWriteResult { added: number; updated: number; total: number }
/** WorkBuddy 配置备份条目；entries 为 null 表示备份文件无法解析（禁用恢复）。 */
export interface WorkbuddyBackup { file: string; at: number; bytes: number; entries: number | null }
/**
 * 「探测可用性」的实时进度快照（GET /models/probe）。
 * phase: catalog=正在刷新清单（行数未知）；channels=正在逐条探测渠道模型；done=已收尾。
 */
export interface ProbeProgress {
  running: boolean
  phase: 'idle' | 'catalog' | 'channels' | 'done'
  done: number
  total: number
  startedAt: number
  finishedAt: number
}
export interface Host {
  navigate(page: Page): void
  refresh(): Promise<void>
  copy(value: string): Promise<void>
  getApiKey(): Promise<string>
  rotateKey(): Promise<string>
  logout(): Promise<void>
  error(error: Error): void
  testModel(model: string, signal: AbortSignal): Promise<ModelTestResult>
  refreshModels(probe: boolean, signal: AbortSignal): Promise<void>
  probeProgress(): Promise<ProbeProgress>
  setModelDisabled(id: string, disabled: boolean): Promise<void>
  saveSettings(settings: Partial<ServiceSettings>): Promise<ServiceSettings>
  listCombos(): Promise<Combo[]>
  saveCombo(combo: ComboDraft): Promise<Combo[]>
  deleteCombo(id: string): Promise<Combo[]>
  syncCombosToWorkbuddy(baseUrl?: string, target?: 'ai'): Promise<WorkbuddySyncResult>
  writeModelToWorkbuddy(id: string, baseUrl?: string, target?: 'ai'): Promise<WorkbuddyWriteResult>
  listWorkbuddyBackups(): Promise<WorkbuddyBackup[]>
  restoreWorkbuddyBackup(file: string): Promise<{ restored: boolean; total: number; at: number }>
  /**
   * 渠道账本快照（`GET /api/management/usage/ledger`）。
   *
   * ⚠️ **刻意不并入 `loadData()` 的 `Promise.all`**：账本数据来自 worker 线程
   * RPC，跨线程 + 逐条序列化，比 `/summary`、`/stats` 慢一个数量级；渠道 worker
   * 一旦挂死，整包 `Promise.all` 会把统计页一起拖成白屏。账本有自己的一条钟
   * （`usage.tsx` 内 6 秒、相对 `/stats` 的 5 秒钟相位错开 3 秒），失败只降级
   * 明细表与实时流两块，其余区块照常渲染。
   *
   * @param limit 明细条数（1–500，缺省 500 = 内存账本全量窗口）
   */
  usageLedger(limit?: number): Promise<UsageLedgerResponse>
  /**
   * 降级尝试环（`GET /api/management/usage/attempts`）。
   *
   * ⚠️ **与 `usageLedger` 是刻意分开的两个端点**：这条路只读**本地** stats store，
   * 不碰渠道 worker —— 所以渠道 worker 挂了它照样能返回，而 `/usage/ledger` 会
   * 502。两者分开放，正是为了不让一个坏掉的源把另一个好源的数据一起拖没。
   * 超时也用默认值（不需要账本那样的长预算）。
   *
   * @param limit 条数（1–200，缺省 200 = 内存环全量）
   */
  usageAttempts(limit?: number): Promise<UsageAttemptsResponse>
}

// ===========================================================================
// 渠道账本（`usage.tokenLedger` / `usage.tokenLedgerHistory` 的真实输出）
// 字段名与 vendor/channel-pack/src/token-ledger.ts 严格一致，不得自造。
// ===========================================================================

/** 流量来自哪条通道：DSH 宿主对话 = `direct`；OpenAI 兼容网关 = `gateway`。 */
export type LedgerChannelKind = 'direct' | 'gateway'

/**
 * 账本聚合小计（= `TokenLedgerModelRow` 去掉 `model`）。
 *
 * ⚠️ 两个 `avg*` 字段**缺失 ≠ 0**：只对「有实测值」的请求取均值（Σ/份数），
 * 无任何可测样本时字段整个不出现，UI 显示 `—`。
 */
export interface LedgerTotals {
  requests: number
  reportedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  errors: number
  /** 平均首字用时（毫秒）；无可测请求时缺失。 */
  avgTtftMs?: number
  /** 平均输出速率（tok/s）；无可测请求时缺失。 */
  avgTps?: number
}

/** 模型粒度的一行。 */
export interface LedgerModelRow extends LedgerTotals {
  model: string
}

/** 一个 provider 下某个账号的聚合（`accountId` 空串 = 未归属）。 */
export interface LedgerAccountRow {
  accountId: string
  models: LedgerModelRow[]
  totals: LedgerTotals
}

/** 一个 provider 下的聚合。 */
export interface LedgerProviderRow {
  provider: string
  accounts: LedgerAccountRow[]
  totals: LedgerTotals
}

/** 一个渠道下的聚合。 */
export interface LedgerChannelRow {
  channel: LedgerChannelKind
  providers: LedgerProviderRow[]
  totals: LedgerTotals
}

/**
 * 一条请求明细。
 *
 * 只声明 UI 真正读的字段：`promptText` / `responseText` / `hasDetail` 等大字段
 * 归日志页（懒加载），本页不碰。
 */
export interface LedgerEntry {
  ts: number
  channel: LedgerChannelKind
  provider: string
  model: string
  accountId?: string
  usageReported: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  ttftMs?: number
  tps?: number
  durationMs: number
  error?: string
}

/** 账本快照：四级聚合树 + 全局小计 + 最近明细（最新在前）。 */
export interface UsageLedgerSnapshot {
  channels: LedgerChannelRow[]
  totals: LedgerTotals
  entries: LedgerEntry[]
}

/** 一天的历史用量行（落盘日聚合，重启保留）。 */
export interface UsageLedgerHistoryDay {
  day: string
  channels: LedgerChannelRow[]
  totals: LedgerTotals
}

/**
 * `/api/management/usage/ledger` 的响应体（`management.mjs` 已解掉 RPC 信封）。
 *
 * 两个 RPC 在一次请求里并发拉取：
 * - `snapshot`：内存明细账本（上限 500 条，重启清空）→ 明细表 / 实时流；
 * - `history` + `historyTotals`：落盘日聚合（近 90 天，重启保留）→ 跨日回溯。
 */
export interface UsageLedgerResponse {
  snapshot: UsageLedgerSnapshot
  history: UsageLedgerHistoryDay[]
  historyTotals: LedgerTotals
  /** 服务端生成时刻（毫秒时间戳）。前端的「今日」口径与桶对齐都以它为准。 */
  generatedAt: number
}

// ===========================================================================
// 页面 ViewModel（纯展示层，不含数据获取语义）
// 批次 1 曾放在 `components/usage/mock-data.ts`，批次 2 接入真实数据后迁到此处，
// 让「mock 常量」与「类型契约」彻底分离。
// ===========================================================================

/** 一次候选尝试的结果。**真实记录里只有这三种**，没有 `ok`/`failed`。 */
export type AttemptOutcome = 'hit' | 'skipped' | 'aborted'

/**
 * 逐候选尝试流水（`/api/management/usage/attempts` 的返回行）。
 *
 * 形状由后端 `src/core/attempts.js#normalizeAttempt` 决定，不是按原型想象的：
 * 它是「组合链走到哪一步」的记录，**不含速度** —— `tps`/`ttftMs` 只存在于单模型
 * 的解码窗口里，`runCombo` 拿不到，编造一个会比没有更糟。速度看实时流（账本实测）。
 */
export interface UsageAttempt {
  /** 回合起点。**同一回合的每一行都相同**，前端靠它分组（不要用 `at` 猜）。 */
  turnAt: number
  /** 本行写入时刻；同一回合内各行互不相等。 */
  at: number
  /** 组合链 id，形如 `combo:auto`。 */
  chainId: string
  /** 组合链显示名。 */
  chainName: string
  /** 链内序号（0 起）。 */
  index: number
  /** 候选的真实模型 id（`qoder/qwen3-max`）。 */
  candidateId: string
  outcome: AttemptOutcome
  /** `skipped` 时的原因原文；`hit` 时为空串。 */
  reason: string
  /** **距本回合起点**的毫秒数，不是本条耗时；本条耗时 = 与上一行的差值。 */
  elapsedMs: number
}

/** `GET /api/management/usage/attempts` 的响应。 */
export interface UsageAttemptsResponse {
  attempts: UsageAttempt[]
  /** 环里现有的条数（可能大于本次返回的 `attempts.length`）。 */
  total: number
  generatedAt: number
}

/** 渠道静态元信息（名称 / 头像字母 / 品牌色）。品牌色不随主题变化，与原型一致。 */
export interface ProviderMeta {
  readonly name: string
  readonly short: string
  readonly accent: string
}

/**
 * 候选行状态：六态。批次 5 用 `UsageAttempt.outcome` 直接映射：
 * `ok → done`、`skipped → skipped`、`failed/aborted → failed`，
 * 尚未拿到的候选为 `pending`，正在探测为 `probing`。
 */
export type CandidateState = 'pending' | 'probing' | 'active' | 'done' | 'skipped' | 'failed'

/** 候选行上的小标签语义（决定标签配色，文案由 `reason` / 状态推导）。 */
export type CandidateLabelKind = 'answering' | 'answered' | 'rate' | 'skip' | 'idle'

/** 路由实况左上角的「来源」卡（哪一路客户端请求进来的）。 */
export interface RoutingSource {
  id: string
  name: string
  /** 品牌色，用作小圆点与连线颜色。 */
  accent: string
  /** 副行：`combo:auto · 并行 2 路` 之类的上下文。 */
  sub: string
  active: boolean
}

/** 路由实况右侧候选链的一行。 */
export interface RoutingCandidate {
  /** 候选真实模型 id，形如 `qoder/qwen3-max`；用作 React key。 */
  candidateId: string
  provider: string
  /** 渠道展示名。 */
  providerName: string
  /** 头像字母。 */
  providerShort: string
  accent: string
  model: string
  /** 账号标签：`#2 Peng`。 */
  account: string
  state: CandidateState
  /**
   * 速度值：
   * - `pending` / `probing` → 该渠道的**平均** tok/s（让用户能横向比较，`is-idle` 灰小字显示）；
   * - `done` / `skipped` / `failed` → `undefined`（显示 `—`，绝不显示 0）。
   *   单次实测速度只存在于账本/`/stats` 样本里，走查记录拿不到 —— 塞均值进去
   *   会被 `isIdleSpeed` 画成非灰的「实测值」，比留白更糟。
   */
  tps?: number
  labelKind: CandidateLabelKind
  /** 标签文案，如 `应答中…` / `已应答` / `429 · 稍后重试`。 */
  label: string
  /** 跳过/失败原因原文，用作标签的 title。 */
  reason?: string
}

/** 「本次请求」条。 */
export interface CurrentRequest {
  /** 展示用请求号（`#8842`）。 */
  id: string
  /** 命中描述：`TRAE · #2 Peng`；未命中为 undefined。 */
  hit?: string
  ttftMs?: number
  tps?: number
  outputTokens: number
  failed: boolean
}

export interface VerdictBullet {
  color: string
  text: string
}

/** 一句话裁决 + 几个彩色要点。 */
export interface Verdict {
  text: string
  bullets: VerdictBullet[]
}

/** hero 底部三个大数字。 */
export interface RoutingTotals {
  /** 本小时物理请求。 */
  requests: number
  /** 降级接管次数（口径见 KPI 第 5 张的 hint）。 */
  reroutes: number
  /** 客户端看到的错误数。 */
  errors: number
}

/** KPI 卡（固定 5 张，顺序由 usage.tsx 决定）。 */
export interface KpiCard {
  key: string
  label: string
  /** 主数字；缺失时传 undefined（渲染 `—`，绝不显示 0）。 */
  value?: number
  /** 小数位（速度类用 1）。 */
  decimals?: number
  /** 单位后缀：`tok/s` / `%` / `次`。 */
  unit?: string
  /** 副行角标：涨跌或成功率。 */
  delta?: { text: string; flat?: boolean }
  /** 副行说明。 */
  hint: string
  /** sparkline 采样（已平滑）；空数组表示无数据，整条隐藏。 */
  spark: number[]
  /** spark 主色（对应 usage-routing.css 里的 `.r-spark.is-*`）。 */
  accent: 'accent' | 'ok' | 'violet' | 'cyan' | 'warn'
  /** 卡片 tooltip。 */
  title?: string
}

/** 实时请求流的一行。 */
export interface StreamRow {
  /** 稳定 key：`at:model:idx`（同毫秒可能重复）。 */
  key: string
  at: number
  provider: string
  providerShort: string
  accent: string
  model: string
  account: string
  /** 实测速度；缺失为 undefined。 */
  tps?: number
  ttftMs?: number
  /** 该请求的 Token 合计；样本里没有时报 undefined（显示 `—`，不伪造成 0）。 */
  tokens?: number
  failed: boolean
  /** 失败原因，用于 title。 */
  reason?: string
}

/** 明细表「按渠道」视图的一行（一行 = channel|provider）。 */
export interface ChannelRow {
  key: string
  channelName: string
  /** 渠道 id（`workbuddy` / `qodercn` …），用于追溯与 key。 */
  provider: string
  /** 渠道展示名（`WorkBuddy 国际版`）。表里渲染这个，id 只当 title。 */
  providerName: string
  providerShort: string
  accent: string
  /** 该 provider 下的账号数（不含「未归属」桶）。 */
  accounts: number
  /** 请求最多的账号。 */
  topAccount: string
  /** token 最多的模型（主力模型）。 */
  topModel: string
  /** 主力模型的完整 top3，用于 title。 */
  topModels: string[]
  totals: LedgerTotals
  /** 请求占比（0–100，整数）。 */
  share: number
  /** 主力账号的请求数（title 用）。 */
  topAccountRequests?: number
  /** 主力账号的 token 合计（title 用）。 */
  topAccountTokens?: number
}

/** 明细表「按模型」视图的一行（跨账号聚合）。 */
export interface ChannelModelRow {
  key: string
  model: string
  providers: number
  accounts: number
  totals: LedgerTotals
  share: number
}

export type ChannelTableMode = 'channel' | 'model'

/** 降级链清单的一行。 */
export interface ChainSummary {
  comboId: string
  /** 展示名（`auto` / `deepseek` / `直连`）。 */
  name: string
  /** 策略原文：`fallback` / `direct` / `round-robin`。 */
  strategy: string
  /** 策略展示名：`顺序降级` / `直连` / `轮询`。 */
  strategyLabel: string
  members: { provider: string; providerName: string; providerShort: string; accent: string; model: string }[]
  /** 本小时请求数（缺失则显示 `—`）。 */
  requests?: number
  reroutes?: number
}

/** 双轴图的两条序列（按时间升序，长度一致）。 */
export interface ThroughputSeries {
  /** 每桶 Token 合计。 */
  tokens: number[]
  /** 每桶平均 tok/s；无样本的桶为 null（图上断线，不画成 0）。 */
  tps: (number | null)[]
  /** 桶宽（ms），用于图注与 tooltip。 */
  bucketMs: number
  /** 最早桶的起始时间戳。 */
  from: number
}

/** 页面数据聚合：一个对象喂 7 个子组件。 */
export interface UsageView {
  providerMeta: Record<string, ProviderMeta>
  /** 路由实况。 */
  sources: RoutingSource[]
  activeChainId: string
  candidates: RoutingCandidate[]
  current: CurrentRequest | null
  verdict: Verdict
  routingTotals: RoutingTotals
  /** B 档 attempts；批次 5 直接填入。 */
  attempts: UsageAttempt[]
  /** KPI 固定 5 张。 */
  kpis: KpiCard[]
  /** 图。 */
  throughput: ThroughputSeries
  /** 实时请求流（最新在前）。 */
  stream: StreamRow[]
  /** 明细表。 */
  ledgerTotals: LedgerTotals
  channelRows: ChannelRow[]
  modelRows: ChannelModelRow[]
  /** 降级链清单。 */
  chains: ChainSummary[]
  /** 口径明细条的 6+2 个业务数字。 */
  strip: BusinessStrip
  /** 「按模型统计」表的原始行（未经搜索/排序/分页，交给 `usageModels()` 处理）。 */
  usageModels: UsageModel[]
}

/**
 * 口径明细条的数据。
 * ⚠️ 口径三分：`turns`（用户回合）与 `requests`（物理请求）来自 `/stats`，
 * `ledgerTotals.requests` 是账本口径的物理请求，三者**永不混用**。
 */
export interface BusinessStrip {
  turns: number
  requests: number
  input: number
  output: number
  failedTurns: number
  recoveredTurns: number
  failedRequests: number
  /** 所选周期（`/stats` 的 chart.total）Token 合计。 */
  windowTotal: number
}
