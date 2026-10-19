/**
 * **Token 账本**（全 provider 的用量流水 + 渠道 × provider × 模型三维聚合）。
 *
 * ## 为什么它必须存在（issue 诉求）
 *
 * 全部适配器在流结束时都已产出 dsh-llm 的标准 `type:'usage'` chunk
 * （`TokenUsage`：`inputTokens / outputTokens / cacheReadTokens /
 * cacheWriteTokens / reasoningTokens / totalTokens`），但解析完就丢弃 ——
 * 用户无法回答「今天用了多少 token」「直连与网关各用多少」。本模块把
 * 「存下来」这一跳补上，**不改任何适配器的推理路径**。
 *
 * ## 记账点：注册收敛层（单点覆盖）
 *
 * 记账由 {@link ./llm-register-compat.ts} 的包装注册调用（每笔请求恰好一次），
 * 不碰 13 个适配器。渠道区分靠网关侧打标（`src/openai-gateway/channel.ts`）：
 * 网关请求在 `GenerateOptions` 上带 `gatewayChannelMark`，读到即 `gateway`，
 * 否则 `direct` —— **精确打标，不是差值估算**。
 *
 * ## 存储是进程内存，重启即丢（刻意，第 1 期与 cline-request-log 同决策）
 *
 * 高频写入的派生数据持久化会把每笔推理变成一次磁盘写；「本周用量」这类
 * 长周期诉求随第 2 期持久化一并做。上限 {@link TOKEN_LEDGER_LIMIT} 条，
 * 写满淘汰最旧。聚合树在读取时按需重建（条数有限，O(n) 足够快，
 * 不为省这点计算引入增量维护的双写复杂度）。
 *
 * ## ⚠️ record() **绝不抛错**：它在推理的关键路径上
 *
 * 与 `src/cline-request-log.ts` 同款约束：这里抛错会把记账失败反噬成
 * 推理失败。所有入参截断/钳制，`Object.freeze` 防止调用方修改共享对象。
 */

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { appendFile, chmod, open } from 'node:fs/promises'
import { Buffer } from 'node:buffer'

/** 一条请求记录。 */
export interface TokenLedgerEntry {
  /** 请求**发起**时刻（毫秒时间戳）。 */
  ts: number
  /** 流量来自哪条通道：DSH 宿主对话 = `direct`；OpenAI 兼容网关 = `gateway`。 */
  channel: 'direct' | 'gateway'
  /** provider id（如 `codearts` / `qoder`）。 */
  provider: string
  /** 模型 id（wire 上的 `model`）。 */
  model: string
  /**
   * **服务本笔请求的账号**（账号池条目 id）。
   *
   * ⚠️ 第 2 期（账号维度）加入。归属口径与 cline-request-log 相同：
   * 以**实际解析出凭据的账号**为准（`resolveCredential` / 池查询回报）。
   * 取不到时为空串 —— 未知账号与「没有账号体系」不能混成一个假 id，
   * 展示层对空串整段不渲染（或归入「未归属」）。
   */
  accountId?: string
  /**
   * 是否收到过 usage chunk。
   *
   * ⚠️ 与「token 为 0」**不是一回事**：没收到 usage（abort / 上游提前断开 /
   * 请求失败）时表格必须显示 `—`，给 0 会被读成「瞬间完成、没花 token」
   * （`cline-request-log` 同约定）。
   */
  usageReported: boolean
  /** 输入 token（未命中缓存的部分，dsh-llm 口径）。 */
  inputTokens: number
  /** 输出 token（含思考 token）。 */
  outputTokens: number
  /** 缓存命中的输入 token（缺失时省略）。 */
  cacheReadTokens?: number
  /** 缓存写入的 token（缺失时省略）。 */
  cacheWriteTokens?: number
  /** 思考 token（缺失时省略；已含在 outputTokens 内）。 */
  reasoningTokens?: number
  /**
   * **首个内容块耗时**（毫秒）—— 用户口中的「首字用时」。
   *
   * 口径与 `cline-request-log.ttftMs` 一致：**收到任何一块**（含思考增量）
   * 的时刻 − 请求发起。0 = 整个流没有产出任何块（失败 / 秒回空），展示层
   * 按「不可测」处理（显示 `—`），不显示 0。
   */
  ttftMs?: number
  /**
   * 全程耗时里**扣除首块之后**的输出速率（tok/s）。
   *
   * 口径对齐官方（`tokens-per-second.js` 抄的 DeepSeek 口径）：分子是
   * **全部输出 token（含思考）**，分母 = `durationMs − ttftMs`（首块之后
   * → 结束）。任一前提缺失（无 usage / 无首块 / 分母 ≤ 0）时**省略字段** ——
   * 不可测与 0 tok/s 是两回事。
   */
  tps?: number
  /** 全程耗时（毫秒）。 */
  durationMs: number
  /** 失败原因；成功行省略。 */
  error?: string
  /**
   * **请求摘要**（独立端增强）：最后一条 user 消息的纯文本，截前 {@link PREVIEW_MAX_CHARS} 字。
   *
   * ⚠️ 上游没有这个字段 —— 本机为「日志详情面板」加的可观测性，缺省省略。
   */
  promptPreview?: string
  /** **返回摘要**（独立端增强）：流内 text-delta 累积，截前 {@link PREVIEW_MAX_CHARS} 字。缺省省略。 */
  responsePreview?: string
  /**
   * **本轮增量内容存在全文**（独立端增强，2026-10-19）。
   *
   * ⚠️ 这里只放一个布尔，**全文不放进 record**：内存账本上限 500 条，
   * 全文（单条中位 77k token）会把常驻内存推到 168MB、把每次快照 RPC 推到
   * 135MB。全文按需从 JSONL 懒加载，见 {@link readEntryDetail}。
   */
  hasDetail?: boolean
  /**
   * 本轮**用户真正说的话**（增量，非全量上下文）。
   *
   * ⚠️ 与 `promptPreview` 的区别：`promptPreview` 是「最后一条 user 消息」，
   * 而 agent 续轮的 user 消息实际是 **tool-result**（网关把 `role:'tool'`
   * 转成 `role:'user'` + `tool-result` 块），文本提取会得到空串 —— 这正是
   * 改造前 93.6% 提问摘要为空的原因。本字段回退到「最近一条带文本的 user」，
   * 再退化到 tool-result 的文本，保证续轮也有可读的提问。
   */
  promptText?: string
  /** 本轮 AI **正文**（流内 text-delta 拼接，未截断；落盘时按 {@link DETAIL_FIELD_MAX_CHARS} 截断）。 */
  responseText?: string
  /** 本轮 AI **思考**（流内 reasoning-delta 拼接；与正文分开存，UI 默认折叠）。 */
  reasoningText?: string
  /**
   * 本轮**工具回填**（tool-result 文本，用于回答「这一轮 AI 在读什么文件/跑什么命令」）。
   * 仅当提问来自 tool-result 时才记，避免与 `promptText` 重复。
   */
  toolText?: string
}

/** 渠道 → provider → 账号 → 模型 聚合里模型粒度的一行。 */
export interface TokenLedgerModelRow {
  model: string
  /** 请求数（含失败）。 */
  requests: number
  /** 收到过 usage 的请求数（usageReported = true 的子集）。 */
  reportedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** 失败请求数。 */
  errors: number
  /**
   * 平均首字用时（毫秒）—— **只对有实测值（ttftMs > 0）的请求取均值**。
   * 失败/秒回空（ttftMs 缺省）的请求不摊薄均值；无任何可测请求时为
   * `undefined`（显示 `—`，与「平均 0ms」严格区分）。
   */
  avgTtftMs?: number
  /**
   * 平均输出速率（tok/s）—— 对**有 tps 实测值**的请求取均值（不加权，
   * 「每笔请求的速率」的算术平均，口径与用户直觉一致）。无可测请求时
   * `undefined`。
   */
  avgTps?: number
}

/** 一个 provider 下、某个账号的聚合（模型行 + 自身小计）。 */
export interface TokenLedgerAccountRow {
  /** 账号池条目 id；空串 = 未归属（凭据解析没回报的请求）。 */
  accountId: string
  models: TokenLedgerModelRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/** 一个 provider 下的聚合（账号行 + 自身小计）。 */
export interface TokenLedgerProviderRow {
  provider: string
  accounts: TokenLedgerAccountRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/** 一个渠道下的聚合（provider 行 + 自身小计）。 */
export interface TokenLedgerChannelRow {
  channel: 'direct' | 'gateway'
  providers: TokenLedgerProviderRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/** 读侧返回：三维聚合树 + 全局小计 + 最近明细。 */
export interface TokenLedgerSnapshot {
  channels: TokenLedgerChannelRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
  /** 最近明细（最新在前），`entries` 的条数即 `limit`（不超上限）。 */
  entries: TokenLedgerEntry[]
}

/** 流水上限。500 条足够回溯近期活动，内存占用可忽略。 */
export const TOKEN_LEDGER_LIMIT = 500

/** 内存中的流水（最新在前）。 */
let ledger: TokenLedgerEntry[] = []

/**
 * **逐条请求日志落盘**（独立端增强，2026-10-18；2026-10-19 改为按天轮转）。
 *
 * 上游只把逐条明细留在进程内存（重启即丢），日聚合才落盘。这里额外把每条
 * record 以 JSONL 追加到 `channel-pack/request-log.jsonl`：启动时回读最近
 * {@link TOKEN_LEDGER_LIMIT} 条进内存 —— 日志页在重启后仍能看到逐条记录。
 *
 * ## 2026-10-19 改造：单文件上限 5MB → 200MB，轮转判据改为「按天」
 *
 * 旧实现按**字节**轮转（`size > 5MB` 就 rename 成 `.old`，只留一份）。摘要
 * 只有 200 字时单条 374B，5MB 能装 14000 条；但老板要求记录**全文**
 * （提问/正文/思考），实测单条中位 345KB（完整上下文快照）—— 5MB 只够
 * **15 条**，等于把「500 条历史」砍成半小时。
 *
 * 现在：①上限提到 200MB；②轮转判据是**UTC+8 日界**（跨天才换文件），
 * 文件名带日期 `request-log-YYYY-MM-DD.jsonl`；③只保留最近
 * {@link ENTRY_LOG_KEEP_DAYS} 天，更早的在轮转时删除。
 *
 * ⚠️ 路径为空串 = 未启用（无盘环境/未挂载 store），所有落盘操作直接返回。
 */
const ENTRY_LOG_MAX_BYTES = 200 * 1024 * 1024

/** 逐条日志保留天数（按 UTC+8 日界切文件，超期文件在轮转时删除）。 */
const ENTRY_LOG_KEEP_DAYS = 7

/** 全文单字段落盘上限（字符）。超出截断并标记，避免单条记录无界膨胀。 */
const DETAIL_FIELD_MAX_CHARS = 200_000

/** 逐条日志路径；由 `createTokenLedgerStore` 通过 {@link configureEntryLog} 注入。 */
let entryLogPath = ''

/** 请求/返回摘要的截断长度（字符）。 */
const PREVIEW_MAX_CHARS = 2000

/**
 * 「该 provider 最近一次解析出的账号」注册表（第 2 期 · 账号维度）。
 *
 * ## 为什么是「最近一次」而不是「本次」
 *
 * 账号归属的**权威**来源在各适配器内部（`currentAccountId` 局部变量），
 * 包装层（`recordThroughStream`）看不到它。为不重写 13 个适配器，采用
 * **侧信道回报**：`index.ts` 的 `resolveCredential` 回调与各适配器的
 * 凭据解析点调用 {@link reportLedgerAccount}，包装层在**收到 usage 帧**
 * 时读取（彼时凭据必然已解析，见 `llm-register-compat.ts` 的时序说明）。
 *
 * ## 归属精度（如实写进 issue 的近似声明）
 *
 * - **单账号 provider**（绝大多数用户每个 provider 只登一个号）⇒ 精确。
 * - **多账号 + 流内换号**：归属记录的是「解析出凭据的那个账号」——
 *   即本轮请求的**起点**。换号（额度用尽等）后 usage 归到新账号要等
 *   该账号再次回报；在换号即时性上它是**近似**，不是 cline-request-log
 *   那种「最终服务账号」的精确口径。
 * - 并发流共用同一 provider 的注册表槽位 ⇒ 交错时按「最后回报」归属。
 *   这是把改动收敛到侧信道的**有意取舍**（全量精确需改 13 个适配器的
 *   内部状态机，收益比不符）。
 */
const reportedAccounts = new Map<string, string>()

/**
 * 回报「该 provider 最近解析出的账号」（凭据解析点调用）。
 *
 * ⚠️ 绝不抛错：它与 {@link recordTokenUsage} 同在推理关键路径上。
 * 空串 / 非串入参直接忽略（不清空旧值 —— 清空语义属于 {@link clearLedgerAccount}）。
 */
export function reportLedgerAccount(provider: string, accountId: string): void {
  try {
    if (typeof provider !== 'string' || provider.length === 0) return
    if (typeof accountId !== 'string' || accountId.length === 0) return
    reportedAccounts.set(provider.slice(0, 64), accountId.slice(0, 64))
  } catch {
    // 回报失败绝不反噬推理。
  }
}

/** 读取该 provider 当前记录的账号（包装层在 usage 帧到达时调用）。 */
export function peekLedgerAccount(provider: string): string {
  return reportedAccounts.get(provider) ?? ''
}

/** 诊断用：注册表当前条数。 */
export function ledgerAccountCount(): number {
  return reportedAccounts.size
}

/** 测试专用：清空回报表。 */
export function resetLedgerAccountsForTests(): void {
  reportedAccounts.clear()
}

/**
 * 日聚合存储后端的**最小契约**（`token-ledger-store.ts` 的实现满足它）。
 *
 * 只声明记账侧真正用到的两个方法 —— 账本模块刻意不 import store 的实现，
 * 以免把 `node:fs` 拖进纯逻辑模块（该模块要能在无盘环境被单测）。
 */
export interface TokenLedgerBackend {
  /** 把一笔请求并入日聚合（内存即时、落盘节流）。 */
  append(entry: TokenLedgerEntry): void
  /** 读取日聚合表（**纯内存读**，不碰磁盘 —— 见 store 的注释）。 */
  load(): TokenLedgerDayMap
}

/**
 * 日聚合后端的**挂载点**（第 2 期 · 落盘 / 第 4 期 · 历史视图共用）。
 *
 * 由 `index.ts` 在插件启动时 {@link attachTokenLedgerStore} 注入；记账路径只调
 * `append`，RPC 只调 `load` —— 与 `record()` 绝不抛错同款约束，持久化失败绝不能
 * 反噬推理。
 *
 * ⚠️ 原先拆成「持久化钩子」与「历史读取器」**两个**独立的挂载点，由 `index.ts`
 * 分别挂、分别摘。那带来了一个真实风险：插件 fiber 重启时新 apply 与旧 fiber 的
 * 异步 dispose **交错执行**（本仓库已确证的事故，见 `llm-register-compat.ts`
 * 模块头），旧实例的 dispose 会把**新实例刚挂上**的钩子一并摘空 ⇒ 落盘彻底停摆
 * 且历史视图恒为空。现在合并为**一个**挂载点，并在 dispose 时做**所有权校验**。
 */
let backend: TokenLedgerBackend | undefined

/**
 * 当前挂载的**唯一身份令牌**。
 *
 * ⚠️ 不能用 `backend === owned` 做判据（审计发现并已复现）：后端对象可能被
 * **同一个对象重复挂载**，此时两个 disposer 的 `owned` 都等于 `backend`，
 * 先调用的那个会把后一次挂载误摘掉。用每次挂载**新生成**的令牌做判据即可根治
 * —— 令牌永不复用，且 `undefined` 之间也不会互相误判。
 */
let backendToken: object | undefined

/**
 * 注入日聚合后端，返回**该次挂载专属的 disposer**。
 *
 * ⚠️ 返回的 disposer 只在「当前挂载的仍是我自己」时才清空 —— 这样 fiber 重启
 * 交错时，旧实例的 dispose 不会摘掉新实例的挂载（见 {@link backend} 的说明）。
 *
 * ⚠️ **幂等性由令牌判据单独提供，不再另设 `disposed` 标志**（审计发现）：
 * 曾经有一个 `if (disposed) return` 守卫，但它是**不可观测的冗余** —— 令牌每次
 * 挂载都新生成且永不复用，故 disposes 重入时 `backendToken === token` 必然为假、
 * 必然让位；删掉守卫行为完全相同（变异测试：删掉后 24 条用例仍全绿，证明它
 * 无法被任何时序观测到）。与其保留一段无用例覆盖、只在注释里声称"幂等"的代码，
 * 不如把它删掉，让"幂等来自令牌判据"成为**唯一**且可被用例锁定的事实。
 *
 * @param next - 后端实现；传 `undefined` = 卸载（测试隔离用）。
 */
export function attachTokenLedgerStore(next: TokenLedgerBackend | undefined): () => void {
  backend = next
  // 每次挂载都换一个新令牌（即使 next 是 undefined、或与上次是同一个对象）。
  const token: object = {}
  backendToken = token
  return () => {
    // ⚠️ 只摘自己的：令牌不匹配说明期间已被别的实例接管（或本 disposer 已被调用
    // 过一次 —— 那时 backendToken 已换代或清空，故重入天然是空操作）。
    if (backendToken === token) {
      backend = undefined
      backendToken = undefined
    }
  }
}

/** RPC 侧读取日聚合表；未挂载（headless 等）返回空表。 */
export function readTokenLedgerDayMap(): TokenLedgerDayMap {
  return backend?.load() ?? new Map()
}

/**
 * **UTC+8 日键**（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术**换算（+8h 后取 UTC 日期），绝不能用 `Date.setHours` 等
 * 本机时区方法 —— 与 `qoder-adapter.ts` 的 `nextUtc8DayStartMs` 同一条纪律：
 * 各渠道的每日额度都按 UTC+8 结算，本机时区不同（出差/改设置）会算错日界。
 */
export function utc8DayKey(ts: number): string {
  const shifted = new Date(ts + 8 * 60 * 60 * 1000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${month}-${day}`
}

/** 数值字段的统一钳制：非有限值/负数 → 0，截断小数。 */
function clampCount(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

/**
 * 记录一笔请求。
 *
 * ⚠️ **本函数绝不抛错**（见模块头）。字段全部截断/钳制，写满即淘汰最旧。
 */
export function recordTokenUsage(entry: Omit<TokenLedgerEntry, 'ts'>): void {
  try {
    const usageReported = entry.usageReported === true
    const cacheRead = clampCount(entry.cacheReadTokens)
    const cacheWrite = clampCount(entry.cacheWriteTokens)
    const reasoning = clampCount(entry.reasoningTokens)
    // 账号：空串/缺失统一省略字段（「未归属」与「空账号」不伪造）。
    const accountId = typeof entry.accountId === 'string' ? entry.accountId.slice(0, 64) : ''
    const ttft = clampCount(entry.ttftMs)
    const duration = clampCount(entry.durationMs)
    const outputTokens = clampCount(entry.outputTokens)
    // 请求/返回摘要（独立端增强）：各截前 PREVIEW_MAX_CHARS 字，空则省略字段。
    const promptPreview = typeof entry.promptPreview === 'string'
      ? entry.promptPreview.slice(0, PREVIEW_MAX_CHARS)
      : ''
    const responsePreview = typeof entry.responsePreview === 'string'
      ? entry.responsePreview.slice(0, PREVIEW_MAX_CHARS)
      : ''
    // 全文三段（2026-10-19）：脱敏 + 截断，**只落盘不进 record**（见 hasDetail 注释）。
    const detail = buildDetail(entry)
    // TPS（官方口径）：分子 = 全部输出 token（含思考），分母 = 首块之后 → 结束。
    // 三个前提（有首块 / 分母 > 0 / usage 已报）缺一个都不可测 ⇒ 省略字段。
    const decodeMs = duration - ttft
    const tps = ttft > 0 && decodeMs > 0 && usageReported
      ? Math.round((outputTokens / (decodeMs / 1000)) * 10) / 10
      : undefined
    const record = Object.freeze({
      ts: Date.now(),
      // channel 只认两个合法值，垃圾值一律落回 `direct`（保守缺省）。
      channel: entry.channel === 'gateway' ? 'gateway' : 'direct',
      provider: String(entry.provider ?? '').slice(0, 64),
      model: String(entry.model ?? '').slice(0, 160),
      ...(accountId.length > 0 ? { accountId } : {}),
      usageReported,
      inputTokens: clampCount(entry.inputTokens),
      outputTokens,
      // 请求/返回摘要（独立端增强）：空则省略（与「没内容」区分不开时缺省更诚实）。
      ...(promptPreview.length > 0 ? { promptPreview } : {}),
      ...(responsePreview.length > 0 ? { responsePreview } : {}),
      // 全文只留一个布尔（2026-10-19）：record 进内存账本（上限 500 条），
      // 全文进去会把常驻内存推到 168MB —— 全文走 JSONL 懒加载。
      ...(detail !== undefined ? { hasDetail: true } : {}),
      // ⚠️ 0 / 缺失一律**省略字段**而不是写 0：与接口注释一致，
      // 「没有缓存命中」与「命中 0 个」无从区分时，缺省是更诚实的表示。
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
      // 首字用时：0 = 无任何块（失败/秒回空）⇒ 省略（不可测 ≠ 0ms）。
      ...(ttft > 0 ? { ttftMs: ttft } : {}),
      ...(tps !== undefined ? { tps } : {}),
      durationMs: duration,
      ...(typeof entry.error === 'string' && entry.error.length > 0
        ? { error: entry.error.slice(0, 200) }
        : {}),
    }) as TokenLedgerEntry
    ledger.unshift(record)
    if (ledger.length > TOKEN_LEDGER_LIMIT) ledger.length = TOKEN_LEDGER_LIMIT
    // 每日聚合落盘（第 2 期）：后端内部自己节流与兜错，这里不再包 try ——
    // 挂载契约要求 append 绝不抛错（见 attachTokenLedgerStore 的说明）。
    try {
      backend?.append(record)
    } catch {
      // 持久化失败绝不反噬推理（双重防御：后端违约也不炸）。
    }
    // 逐条明细落盘（独立端增强）：record + 全文三段一起写，内部自带兜错，不抛。
    appendEntryLog(record, detail)
  } catch {
    // 记账失败绝不反噬推理（见函数注释）。
  }
}

/**
 * 注入逐条日志路径，并**回读**已有记录进内存（独立端增强）。
 *
 * 由 `createTokenLedgerStore` 在定位到 DSH home 后调用 —— 路径解析留在 store
 * 模块，本模块不碰 home 的定位逻辑（与「账本不 import store 实现」同一条边界）。
 */
export function configureEntryLog(path: string): void {
  entryLogPath = typeof path === 'string' ? path : ''
  restoreLedgerFromEntryLog()
}

/** 落盘用的全文三段（不进内存 record，见 {@link TokenLedgerEntry.hasDetail}）。 */
interface EntryDetail {
  promptText?: string
  toolText?: string
  responseText?: string
  reasoningText?: string
}

/**
 * 把单字段脱敏 + 截断（2026-10-19）。
 *
 * ## 为什么要脱敏
 *
 * 改造前只存 200 字摘要，泄密面有限；改为全文后，落盘文件会包含 API Key、
 * 私钥、密码、内网地址、客户数据 —— 而文件权限默认是 `-rw-r--r--`（同机
 * 其他用户可读）。这里做**尽力而为**的替换：命中即打码，宁可误伤也不漏。
 *
 * ⚠️ 这是「降低暴露面」而非「保证安全」：正则挡不住所有形态。真正的边界
 * 是文件权限 `0o600`（见 {@link appendEntryLog}）与「不主动外发」。
 */
function redactSecrets(text: string): string {
  return text
    // 常见厂商密钥前缀（OpenAI/Anthropic/GitHub/AWS/Google/Slack/Stripe）。
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '$1-***REDACTED***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***REDACTED***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***REDACTED***')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza***REDACTED***')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***REDACTED***')
    // PEM 私钥整段（跨行的 BEGIN/END 之间全部打码）。
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '-----BEGIN PRIVATE KEY-----***REDACTED***-----END PRIVATE KEY-----')
    // `password=xxx` / `api_key: xxx` / `token=xxx` 形态的键值对。
    .replace(/((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*)(['"]?)[^\s'",;]{6,}\2/gi,
      '$1$2***REDACTED***$2')
    // 中国大陆手机号与 18 位身份证号（只保留首尾便于核对）。
    .replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2')
    .replace(/\b(\d{6})\d{8}(\d{3}[0-9Xx])\b/g, '$1********$2')
}

/**
 * 组装全文三段：脱敏 → 截断 → 去空。
 *
 * 四段全空时返回 `undefined`（= 本条无详情，不写 `hasDetail`，避免前端
 * 点了展开才发现是空的）。
 */
function buildDetail(entry: Omit<TokenLedgerEntry, 'ts'>): EntryDetail | undefined {
  const clean = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0) return ''
    const redacted = redactSecrets(value)
    return redacted.length > DETAIL_FIELD_MAX_CHARS
      ? `${redacted.slice(0, DETAIL_FIELD_MAX_CHARS)}\n…（已截断，原 ${redacted.length} 字）`
      : redacted
  }
  const promptText = clean(entry.promptText)
  const toolText = clean(entry.toolText)
  const responseText = clean(entry.responseText)
  const reasoningText = clean(entry.reasoningText)
  if (promptText === '' && toolText === '' && responseText === '' && reasoningText === '') {
    return undefined
  }
  return {
    ...(promptText.length > 0 ? { promptText } : {}),
    ...(toolText.length > 0 ? { toolText } : {}),
    ...(responseText.length > 0 ? { responseText } : {}),
    ...(reasoningText.length > 0 ? { reasoningText } : {}),
  }
}

/**
 * 写盘队列（2026-10-19）：`appendFileSync` → 异步追加。
 *
 * ## 为什么必须异步
 *
 * 旧实现是 `appendFileSync`，在请求结束的 `finally` 里同步写。摘要 374B 时
 * 无所谓；全文单条中位 345KB（含图可达 MB 级），同步写会**卡住事件循环**，
 * 直接拖慢流式响应尾包与并发请求 —— 而这发生在推理关键路径上。
 *
 * 队列保证**顺序**（同一文件并发 append 会交错撕裂行），失败只丢明细。
 * 队列深度设上限：写盘长期跟不上时丢最旧的，绝不无限堆积内存。
 */
const writeQueue: string[] = []
let writing = false
const WRITE_QUEUE_MAX = 256

/** 当前落盘文件的「日键」（UTC+8），用于判断是否跨天轮转。 */
let entryLogDay = ''

/** `request-log.jsonl` → `request-log-YYYY-MM-DD.jsonl`（同目录）。 */
function dayLogPath(day: string): string {
  if (entryLogPath === '') return ''
  const slash = entryLogPath.lastIndexOf('/')
  const dir = slash >= 0 ? entryLogPath.slice(0, slash + 1) : ''
  const base = slash >= 0 ? entryLogPath.slice(slash + 1) : entryLogPath
  const stem = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base
  return `${dir}${stem}-${day}.jsonl`
}

/**
 * 跨天轮转：把当前文件改名为带日期的名字，并删除超期文件。
 *
 * ⚠️ 只在**日键变化**时执行一次（每天首次写入），不是每条都 stat —— 旧实现
 * 每条都要 `existsSync + statSync`，在全文体积下这本身也是可观测开销。
 */
function rotateIfNeeded(nowTs: number): void {
  const day = utc8DayKey(nowTs)
  if (day === entryLogDay) return
  entryLogDay = day
  try {
    // 先把「还在用旧名」的文件归档到它的真实日期名下。
    if (existsSync(entryLogPath)) {
      const stat = statSync(entryLogPath)
      // 用 mtime 判定这份文件属于哪一天（跨天前的最后写入时刻）。
      const fileDay = utc8DayKey(stat.mtimeMs)
      const target = dayLogPath(fileDay)
      if (target !== '' && target !== entryLogPath) {
        try {
          renameSync(entryLogPath, target)
        } catch {
          // 归档失败不影响继续写当前文件。
        }
      }
    }
    pruneOldLogs()
  } catch {
    // 轮转失败绝不反噬推理。
  }
}

/** 删除超过 {@link ENTRY_LOG_KEEP_DAYS} 天的日志文件。 */
function pruneOldLogs(): void {
  if (entryLogPath === '') return
  try {
    const slash = entryLogPath.lastIndexOf('/')
    const dir = slash >= 0 ? entryLogPath.slice(0, slash) : '.'
    const cutoff = Date.now() - ENTRY_LOG_KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const name of readdirSync(dir)) {
      if (!/^request-log-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
      const full = `${dir}/${name}`
      try {
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true })
      } catch {
        // 单个文件删除失败跳过。
      }
    }
  } catch {
    // 目录读不到等价于「没有旧文件」。
  }
}

/** 取队列里的一行写盘（异步、串行）。写盘失败只丢这一行。 */
async function drainWriteQueue(): Promise<void> {
  if (writing) return
  writing = true
  try {
    while (writeQueue.length > 0) {
      const line = writeQueue.shift() as string
      try {
        // 权限 0o600：全文含敏感信息，不能给同机其他用户读（默认 0644）。
        // ⚠️ `mode` 只在**创建**时生效 —— 老文件（改造前建的 0644）需要显式 chmod，
        // 否则「权限收紧了」只是假象（实测本机 request-log.jsonl 仍是 -rw-r--r--）。
        await appendFile(entryLogPath, line, { encoding: 'utf-8', mode: 0o600 })
        await tightenLogPermissions()
      } catch {
        // 单行写失败不中断队列。
      }
    }
  } finally {
    writing = false
  }
}

/** 已收紧过权限的路径（避免每行都 chmod）。 */
let permissionFixed = ''

/**
 * 把日志文件权限收到 `0o600`（只在首次写入后做一次）。
 *
 * ⚠️ 失败不抛：权限收紧是**尽力而为**的加固，不能因为文件系统不支持（如
 * Windows / 网络盘）就让写盘失败。
 */
async function tightenLogPermissions(): Promise<void> {
  if (permissionFixed === entryLogPath) return
  try {
    await chmod(entryLogPath, 0o600)
    permissionFixed = entryLogPath
  } catch {
    // 平台不支持 / 权限不足：跳过。
  }
}

/**
 * 追加一条记录到 JSONL（独立端增强）。
 *
 * ⚠️ **绝不抛错**（与 recordTokenUsage 同约束）：写盘失败最多丢一条明细，
 * 不能反噬推理。全文三段拼在 record 同一行里，`readEntryDetail` 按 `ts` 反查。
 */
function appendEntryLog(record: TokenLedgerEntry, detail: EntryDetail | undefined): void {
  if (entryLogPath === '') return
  try {
    rotateIfNeeded(record.ts)
    const payload = detail === undefined ? record : { ...record, ...detail }
    writeQueue.push(`${JSON.stringify(payload)}\n`)
    // 队列超深：丢最旧的（写盘跟不上时保新不保旧）。
    while (writeQueue.length > WRITE_QUEUE_MAX) writeQueue.shift()
    void drainWriteQueue()
  } catch {
    // 落盘失败绝不反噬推理。
  }
}

/**
 * **按 ts 读取一条记录的全文**（2026-10-19 懒加载）。
 *
 * ## 为什么不做成内存字段
 *
 * 全文单条中位 345KB（完整上下文快照场景），500 条内存账本 = 168MB 常驻，
 * 且每次 `usage.tokenLedger` 快照 RPC 都要把它序列化下发（前端一次拉 400 条
 * = 135MB）。所以 record 里只留 `hasDetail: true`，用户**点开某一行**时才读。
 *
 * ## 为什么从文件尾往前扫
 *
 * 用户点的几乎总是最近几条。从尾部分块读（64KB 一块）直到凑够目标行，
 * 命中即停 —— 比整文件 parse 快几个数量级，且内存峰值只有几块。
 *
 * 返回 `undefined` = 该 ts 没有详情（旧记录 / 已轮转删除 / 读取失败）。
 */
export async function readEntryDetail(ts: number): Promise<EntryDetail | undefined> {
  if (entryLogPath === '' || !Number.isFinite(ts)) return undefined
  const candidates: string[] = []
  try {
    if (existsSync(entryLogPath)) candidates.push(entryLogPath)
    // 跨天后当前文件可能已经归档到日期名下：把最近几个也纳入候选。
    for (let back = 0; back < 3; back += 1) {
      const day = utc8DayKey(ts - back * 24 * 60 * 60 * 1000)
      const path = dayLogPath(day)
      if (path !== '' && !candidates.includes(path)) candidates.push(path)
    }
  } catch {
    return undefined
  }
  for (const path of candidates) {
    const hit = await scanFileForTs(path, ts)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 从文件尾按 64KB 块回扫，找 `ts` 匹配的行并解析出全文三段。 */
async function scanFileForTs(path: string, ts: number): Promise<EntryDetail | undefined> {
  const CHUNK = 64 * 1024
  let handle
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    let position = size
    let carry = ''
    while (position > 0) {
      const length = Math.min(CHUNK, position)
      position -= length
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, position)
      const text = buffer.toString('utf-8') + carry
      const lines = text.split('\n')
      // 第一段可能被块边界切断，留到下一轮与更前面的内容拼接。
      carry = position > 0 ? (lines.shift() as string) : ''
      // 从后往前：最近的记录优先命中。
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]
        if (line.trim().length === 0) continue
        // 先做廉价的子串预筛，避免对每行都 JSON.parse。
        if (!line.includes(`"ts":${ts}`) && !line.includes(`"ts": ${ts}`)) continue
        try {
          const parsed = JSON.parse(line) as TokenLedgerEntry & EntryDetail
          if (parsed?.ts !== ts) continue
          const detail: EntryDetail = {
            ...(typeof parsed.promptText === 'string' ? { promptText: parsed.promptText } : {}),
            ...(typeof parsed.toolText === 'string' ? { toolText: parsed.toolText } : {}),
            ...(typeof parsed.responseText === 'string' ? { responseText: parsed.responseText } : {}),
            ...(typeof parsed.reasoningText === 'string' ? { reasoningText: parsed.reasoningText } : {}),
          }
          return Object.keys(detail).length > 0 ? detail : undefined
        } catch {
          // 坏行跳过。
        }
      }
    }
  } catch {
    // 文件不存在 / 读失败 = 没有详情。
  } finally {
    try {
      await handle?.close()
    } catch {
      // 关闭失败无需处理。
    }
  }
  return undefined
}

/**
 * 启动时回读最近 {@link TOKEN_LEDGER_LIMIT} 条进内存（独立端增强）。
 *
 * ⚠️ **2026-10-19 起必须剥离全文三段**：JSONL 里现在存了 `promptText` /
 * `toolText` / `responseText` / `reasoningText`，直接 `unshift` 进 `ledger`
 * 会把 168MB 常驻内存。回读只保留 record 字段，全文由 {@link readEntryDetail}
 * 按需读盘。
 *
 * 数据源按「新 → 旧」：当天文件 → 最近的日期归档文件 → 旧版 `.old` / 当前名。
 * 坏行（半截写、手工改坏）逐行跳过，不整份放弃。
 */
function restoreLedgerFromEntryLog(): void {
  if (entryLogPath === '') return
  try {
    const readText = (path: string): string => {
      try {
        return existsSync(path) ? readFileSync(path, 'utf-8') : ''
      } catch {
        return ''
      }
    }
    // 候选文件：当天 → 往前 7 天 → 旧命名（兼容改造前的数据）。
    const paths: string[] = [entryLogPath]
    for (let back = 0; back < ENTRY_LOG_KEEP_DAYS; back += 1) {
      const day = utc8DayKey(Date.now() - back * 24 * 60 * 60 * 1000)
      const path = dayLogPath(day)
      if (path !== '' && !paths.includes(path)) paths.push(path)
    }
    paths.push(`${entryLogPath}.old`)
    // ⚠️ 顺序：后面的（更旧）先读、unshift 后翻到前面，保证最终「最新在前」。
    const lines: string[] = []
    for (const path of [...paths].reverse()) {
      const text = readText(path)
      if (text.length === 0) continue
      lines.push(...text.split('\n').filter(line => line.trim().length > 0))
    }
    for (const line of lines.slice(-TOKEN_LEDGER_LIMIT)) {
      try {
        const parsed = JSON.parse(line) as TokenLedgerEntry & EntryDetail
        if (typeof parsed?.ts !== 'number') continue
        // 剥离全文：内存只留 record 字段（全文按需读盘）。
        const {
          promptText: _p, toolText: _t, responseText: _r, reasoningText: _n,
          ...record
        } = parsed
        ledger.unshift(record as TokenLedgerEntry)
      } catch {
        // 坏行跳过。
      }
    }
    if (ledger.length > TOKEN_LEDGER_LIMIT) ledger.length = TOKEN_LEDGER_LIMIT
  } catch {
    // 回读失败等价于「没有历史」。
  }
}

/**
 * 从一条消息的 `content` 里抽文本（多形态兼容）。
 *
 * 支持：①纯字符串；②分块数组里的 `{type:'text'}`；③**`tool-result` 块**
 * （2026-10-19 新增）—— 网关把 `role:'tool'` 转成 `role:'user'` 时，content
 * 里是 `{type:'tool-result', content:[...]}`，旧实现只认 `type:'text'`，
 * 于是续轮提问恒为空串（改造前 93.6% 的「本条没有内容摘要」就是这么来的）。
 */
function textOfContent(content: unknown, includeToolResult: boolean): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  const walk = (blocks: unknown[]): void => {
    for (const raw of blocks) {
      if (typeof raw === 'string') { parts.push(raw); continue }
      if (typeof raw !== 'object' || raw === null) continue
      const block = raw as { type?: unknown; text?: unknown; content?: unknown }
      if (block.type === 'text' && typeof block.text === 'string') { parts.push(block.text); continue }
      // tool-result 的正文可能再嵌一层块数组（多段输出）。
      if (includeToolResult && block.type === 'tool-result' && Array.isArray(block.content)) {
        walk(block.content)
      }
    }
  }
  walk(content)
  return parts.join(' ')
}

/**
 * 从 `GenerateOptions.messages` 提取「本轮用户真正说的话」（独立端增强）。
 *
 * ## 2026-10-19 改造：解决续轮全空
 *
 * 旧实现只取**最后一条 `role==='user'`**。但 agent 续轮里那条 user 消息的
 * content 是 `tool-result`（网关把 `role:'tool'` 转成 `role:'user'`），
 * 只认 `type:'text'` 的提取器拿到空串 —— 实测 376 条里 352 条（93.6%）
 * 提问摘要为空，正是这个原因。
 *
 * 新策略（只取**本轮**内容，不重记历史）：
 * 1. 最后一条 user 里**有真正的文本块** → 用它（首轮对话即此路径）。
 * 2. 最后一条 user 是 tool-result → 继续往前找最近一条带文本的 user
 *    （= 本轮用户的原话，因为续轮不会再插新的人类消息）；tool-result
 *    的文本单独记为 `tool`。
 * 3. 都没有 → 提问为空（`tool` 仍可能非空）。
 *
 * ⚠️ 只扫最后若干条：`messages` 可能上万条，扫全量会拖慢热路径。
 */
export function promptTextOfOptions(options: unknown): { prompt: string; tool: string } {
  const EMPTY = { prompt: '', tool: '' }
  try {
    const messages = (options as { messages?: unknown })?.messages
    if (!Array.isArray(messages)) return EMPTY
    const SCAN_LIMIT = 40
    let tool = ''
    for (let index = messages.length - 1, seen = 0; index >= 0 && seen < SCAN_LIMIT; index -= 1, seen += 1) {
      const message = messages[index] as { role?: unknown; content?: unknown }
      if (message?.role !== 'user') continue
      const content = message.content
      // 第 1 优先：真正的文本块。
      const plain = textOfContent(content, false).replace(/\s+/g, ' ').trim()
      if (plain.length > 0) {
        return { prompt: plain.slice(0, PREVIEW_MAX_CHARS), tool }
      }
      // 第 2 优先：tool-result 的文本 —— 记为工具回填，继续往前找人类原话。
      if (tool === '') {
        const viaTool = textOfContent(content, true).replace(/\s+/g, ' ').trim()
        if (viaTool.length > 0) tool = viaTool.slice(0, PREVIEW_MAX_CHARS)
      }
    }
    return { prompt: '', tool }
  } catch {
    // 提取失败不影响记账。
    return EMPTY
  }
}

/**
 * 兼容旧签名的薄封装（只返回提问文本）。
 *
 * @deprecated 新代码用 {@link promptTextOfOptions}，它同时给出工具回填文本。
 */
export function previewTextOfOptions(options: unknown): string {
  return promptTextOfOptions(options).prompt
}

/** 空聚合行（防重复初始化代码）。返回**累加形态**，finalize 由读取层收尾。 */
function emptyTotals(): AccumulatingTotals {
  return {
    requests: 0,
    reportedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    errors: 0,
    // 均值的**累加器**：先攒 Σ 与份数，读取收尾时才算除法（见 finalizeAverages）。
    ttftSumMs: 0,
    ttftCount: 0,
    tpsSum: 0,
    tpsCount: 0,
  }
}

/** 聚合行的内部形态：均值以 Σ/份数 累加，最终快照前收尾成 `avgXxx`。 */
export interface AccumulatingTotals extends Omit<TokenLedgerModelRow, 'model'> {
  ttftSumMs: number
  ttftCount: number
  tpsSum: number
  tpsCount: number
}

/**
 * Σ/份数 → 均值（无样本时省略字段；均值取 1 位小数与 TPS 精度对齐）。
 *
 * ⚠️ **逐字段显式挑选，不得写成 `{...t}` 展开**：`AccumulatingTotals` 比
 * `TokenLedgerModelRow` 多四个**内部累加器**（`ttftSumMs` / `ttftCount` /
 * `tpsSum` / `tpsCount`）。展开会把它们一并带进返回值 —— 类型签名声明的是
 * `Omit<TokenLedgerModelRow,'model'>`，于是「类型与实际不符」：这四个字段会真的
 * 下发到 RPC 载荷（UI 不读 = 纯虚胖），更危险的是调用方若误用 `ttftSumMs`
 * 会拿到 **Σ 而不是均值**（名字只差一个 `avg`）。
 */
function finalizeAverages(t: AccumulatingTotals): Omit<TokenLedgerModelRow, 'model'> {
  return {
    requests: t.requests,
    reportedRequests: t.reportedRequests,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    reasoningTokens: t.reasoningTokens,
    errors: t.errors,
    ...(t.ttftCount > 0 ? { avgTtftMs: Math.round(t.ttftSumMs / t.ttftCount) } : {}),
    ...(t.tpsCount > 0 ? { avgTps: Math.round((t.tpsSum / t.tpsCount) * 10) / 10 } : {}),
  }
}

/** 把一条记录累加进聚合行。 */
function accumulate(totals: AccumulatingTotals, entry: TokenLedgerEntry): void {
  totals.requests += 1
  if (entry.usageReported) totals.reportedRequests += 1
  if (entry.error !== undefined) totals.errors += 1
  // 均值的样本采集：**只收有实测值**的请求。失败/秒回空（ttft 缺省）与
  // 不可测 TPS 不参与 —— 它们没有测量值，混进去等于用「没测到」摊薄「测到的」。
  if (entry.ttftMs !== undefined && entry.ttftMs > 0) {
    totals.ttftSumMs += entry.ttftMs
    totals.ttftCount += 1
  }
  if (entry.tps !== undefined && entry.tps > 0) {
    totals.tpsSum += entry.tps
    totals.tpsCount += 1
  }
  // ⚠️ 只有 usageReported 的行才计入 token 汇总：失败行/未报行写 0 会把
  // 「没收到用量」混进「真的用了 0」，摊薄均值类读数。
  if (!entry.usageReported) return
  totals.inputTokens += entry.inputTokens
  totals.outputTokens += entry.outputTokens
  totals.cacheReadTokens += entry.cacheReadTokens ?? 0
  totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0
  totals.reasoningTokens += entry.reasoningTokens ?? 0
}

/** 排序键：token 合计降序（谁烧得多谁在前），纯读取层约定。 */
function sumTokens(t: Omit<TokenLedgerModelRow, 'model'>): number {
  return t.inputTokens + t.outputTokens
}

/**
 * 读取账本快照（聚合树 + 全局小计 + 最近明细）。
 *
 * 纯读取、不改状态；每次按需重建聚合树（见模块头「不为 O(n) 引入双写」）。
 * 聚合与明细都来自同一份 `ledger`，**天然同源**——不存在「树与小计各算一遍」
 * 的口径漂移。各级排序：渠道按 `direct → gateway`、provider/账号/模型按 token
 * 合计降序（谁烧得多谁在前）。
 */
export function readTokenLedger(options: { limit?: number } = {}): TokenLedgerSnapshot {
  const limit = Math.max(0, Math.min(options.limit ?? TOKEN_LEDGER_LIMIT, TOKEN_LEDGER_LIMIT))

  // ── 第一遍：逐条累加进四级聚合（全局小计顺路算出）──
  // ⚠️ 各级小计都是 **AccumulatingTotals**（Σ/份数累加）—— 父级均值必须由
  // 「全部样本的 Σ/份数」算出，若按「子级均值再平均」会在样本数不等时算错
  //（3 笔 100ms 与 1 笔 200ms，先平均再平均得 150，正确值 125）。
  const totals = emptyTotals()
  /** channel → provider → account → model → 聚合行（累加形态） */
  const channelMap = new Map<TokenLedgerEntry['channel'], Map<string, Map<string, Map<string, AccumulatingTotals>>>>()
  for (const entry of ledger) {
    accumulate(totals, entry)
    let providers = channelMap.get(entry.channel)
    if (providers === undefined) {
      providers = new Map()
      channelMap.set(entry.channel, providers)
    }
    let accounts = providers.get(entry.provider)
    if (accounts === undefined) {
      accounts = new Map()
      providers.set(entry.provider, accounts)
    }
    // ⚠️ 空账号统一落 `'-'` 桶（Map 键不能缺失）：它是**真实存在的分组**
    // （「未归属」——凭据解析没回报的请求），不能并进任何一个账号。
    const accountKey = entry.accountId !== undefined && entry.accountId.length > 0 ? entry.accountId : '-'
    let models = accounts.get(accountKey)
    if (models === undefined) {
      models = new Map()
      accounts.set(accountKey, models)
    }
    let row = models.get(entry.model)
    if (row === undefined) {
      row = emptyTotals()
      models.set(entry.model, row)
    }
    accumulate(row, entry)
  }

  // ── 第二遍：把 Map 树落成数组并逐级求小计（父级 = 子级之和，Σ/份数直加）──
  // 收尾顺序：模型行 → 账号小计 → provider 小计 → 渠道小计 → 全局小计，
  // 每级在「把 Σ/份数交给父级之后」才 finalize（finalize 只做除法不改 Σ）。
  const channels: TokenLedgerChannelRow[] = [...channelMap.entries()]
    .sort(([a], [b]) => (a === 'direct' ? -1 : 1) - (b === 'direct' ? -1 : 1))
    .map(([channel, providers]) => {
      const channelTotals = emptyTotals()
      const providerRows: TokenLedgerProviderRow[] = [...providers.entries()].map(([provider, accounts]) => {
        const providerTotals = emptyTotals()
        const accountRows: TokenLedgerAccountRow[] = [...accounts.entries()].map(([accountId, models]) => {
          const accountTotals = emptyTotals()
          const modelRows: TokenLedgerModelRow[] = [...models.entries()].map(([model, row]) => {
            // 账号小计 = 其各模型行之和（Σ/份数直加，均值收尾在后面）
            for (const key of Object.keys(row) as (keyof typeof row)[]) {
              accountTotals[key] += row[key] ?? 0
            }
            return { model, ...finalizeAverages(row) }
          }).sort((a, b) => sumTokens(b) - sumTokens(a))
          // provider 小计 = 其各账号之和
          for (const key of Object.keys(accountTotals) as (keyof typeof accountTotals)[]) {
            providerTotals[key] += accountTotals[key] ?? 0
          }
          return { accountId, models: modelRows, totals: finalizeAverages(accountTotals) }
        }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
        // 渠道小计 = 其各 provider 之和
        for (const key of Object.keys(providerTotals) as (keyof typeof providerTotals)[]) {
          channelTotals[key] += providerTotals[key] ?? 0
        }
        return { provider, accounts: accountRows, totals: finalizeAverages(providerTotals) }
      }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
      return { channel, providers: providerRows, totals: finalizeAverages(channelTotals) }
    })

  return {
    channels,
    totals: finalizeAverages(totals),
    entries: ledger.slice(0, limit),
  }
}

/**
 * 测试与 dispose 专用：清空账本。
 *
 * ⚠️ 不导出给 RPC/UI —— 正常运行时账本不该被外部清空（用户看到「突然归零」
 * 会以为丢了数据）；只有单测需要隔离状态。
 */
export function resetTokenLedgerForTests(): void {
  ledger = []
}

/** 当前保留的流水条数（诊断用）。 */
export function tokenLedgerSize(): number {
  return ledger.length
}

/**
 * **每日聚合**的落盘负载（第 2 期持久化）。
 *
 * 键结构：`日键 → 渠道|provider|账号|模型 → 累计值`。与「明细不持久化」的
 * 决策一致：明细在 UI 已有内存版（500 条），落盘只解决「重启后还能看历史
 * 总量」的诉求，而这个诉求的天然粒度就是**日**。
 */
export interface TokenLedgerDayKey {
  channel: 'direct' | 'gateway'
  provider: string
  /** 空串 = 未归属。 */
  accountId: string
  model: string
}

/** 一个日聚合桶的累计值。 */
export interface TokenLedgerDayBucket {
  requests: number
  reportedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  errors: number
  /** Σ(首字用时) 与样本数 —— 均值由读取方计算（Σ/份数，避免存小数漂移）。 */
  ttftSumMs: number
  ttftCount: number
  /** Σ(TPS) 与样本数（同上）。 */
  tpsSum: number
  tpsCount: number
}

/** 每日聚合表：`日键 → (桶键 → 桶)`。序列化形态由 store 负责。 */
export type TokenLedgerDayMap = Map<string, Map<string, TokenLedgerDayBucket>>

/** 桶键（同进程内用 `|` 拼；含转义，见 `dayBucketKeyOf`）。 */
export function dayBucketKeyOf(key: TokenLedgerDayKey): string {
  // ⚠️ provider/model/accountId 都可能含 `|`？账号池 id 与模型 id 实测不含，
  // 但防御性转义：把 `|` 换成 `/`（丢失可接受，它只影响极端名字的分桶边界）。
  const esc = (s: string): string => s.replaceAll('|', '/')
  return `${key.channel}|${esc(key.provider)}|${esc(key.accountId)}|${esc(key.model)}`
}

/** 把一笔记录累加进日聚合表（store 的 load/merge 共用）。 */
export function mergeDayEntry(days: TokenLedgerDayMap, entry: TokenLedgerEntry): void {
  const day = utc8DayKey(entry.ts)
  let buckets = days.get(day)
  if (buckets === undefined) {
    buckets = new Map()
    days.set(day, buckets)
  }
  const key = dayBucketKeyOf({
    channel: entry.channel,
    provider: entry.provider,
    accountId: entry.accountId ?? '',
    model: entry.model,
  })
  let bucket = buckets.get(key)
  if (bucket === undefined) {
    bucket = {
      requests: 0,
      reportedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      errors: 0,
      ttftSumMs: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
    }
    buckets.set(key, bucket)
  }
  bucket.requests += 1
  if (entry.usageReported) bucket.reportedRequests += 1
  if (entry.error !== undefined) bucket.errors += 1
  // 均值样本：与内存聚合同口径，只收有实测值的请求。
  if (entry.ttftMs !== undefined && entry.ttftMs > 0) {
    bucket.ttftSumMs += entry.ttftMs
    bucket.ttftCount += 1
  }
  if (entry.tps !== undefined && entry.tps > 0) {
    bucket.tpsSum += entry.tps
    bucket.tpsCount += 1
  }
  if (!entry.usageReported) return
  bucket.inputTokens += entry.inputTokens
  bucket.outputTokens += entry.outputTokens
  bucket.cacheReadTokens += entry.cacheReadTokens ?? 0
  bucket.cacheWriteTokens += entry.cacheWriteTokens ?? 0
  bucket.reasoningTokens += entry.reasoningTokens ?? 0
}

// ───────────────────────── 历史视图（第 4 期）─────────────────────────

/** 解析日聚合桶键（`channel|provider|account|model`）为结构化键。 */
function parseDayBucketKey(key: string): TokenLedgerDayKey | undefined {
  // dayBucketKeyOf 用 `|` 拼接且把值里的 `|` 转义成 `/`，故 split 恒得 4 段。
  const parts = key.split('|')
  if (parts.length !== 4) return undefined
  const [channel, provider, accountId, model] = parts
  if (channel !== 'direct' && channel !== 'gateway') return undefined
  return { channel, provider, accountId: accountId ?? '', model: model ?? '' }
}

/** 一天的历史用量行（`readTokenLedgerHistory` 的返回元素）。 */
export interface TokenLedgerHistoryDay {
  /** UTC+8 日键（`YYYY-MM-DD`）。 */
  day: string
  channels: TokenLedgerChannelRow[]
  totals: Omit<TokenLedgerModelRow, 'model'>
}

/**
 * 从日聚合表读取**历史视图**（可按日期范围过滤）。
 *
 * ⚠️ 数据源是**落盘的日聚合**（重启保留），与内存明细（500 条、重启清空）
 * 是**两份独立数据**：历史视图答「本周/本月用了多少」，明细答「每一笔
 * 长什么样」。读取是纯计算（Map 树 → 数组），不碰磁盘。
 *
 * @param days - 日聚合表（store 的 `load()` 结果，含启动时从盘上加载的历史）。
 * @param options.sinceDays - 只看最近 N 天（**含今天**，UTC+8 日界）；
 *   省略 = 全部历史（上限 {@link TOKEN_LEDGER_HISTORY_MAX_DAYS}）。
 */
export function readTokenLedgerHistory(
  days: TokenLedgerDayMap,
  options: { sinceDays?: number } = {},
): { days: TokenLedgerHistoryDay[]; totals: Omit<TokenLedgerModelRow, 'model'> } {
  // 过滤窗口：today（UTC+8）往前推 sinceDays-1 天；0/负数按「仅今日」处理。
  const sinceDaysRaw = options.sinceDays
  const sinceDays = typeof sinceDaysRaw === 'number' && Number.isFinite(sinceDaysRaw) && sinceDaysRaw > 0
    ? Math.floor(sinceDaysRaw)
    : undefined
  // ⚠️ `utc8DayKey` 内部已做 +8h 平移，这里必须传**原始**时刻：
  // 先平移再传会让 cutoff 再多 8 小时（cutoff 落到「明天」，连今天都被裁掉）。
  const todayKey = utc8DayKey(Date.now())
  const cutoffKey = sinceDays === undefined
    ? undefined
    : utc8DayKey(Date.now() - (sinceDays - 1) * 24 * 60 * 60 * 1000)

  const grandTotals = emptyTotals()
  const historyDays: TokenLedgerHistoryDay[] = []
  // 日键排序：新在前（字符串比较即时间序，YYYY-MM-DD 是字典序安全的）。
  const dayKeys = [...days.keys()].sort((a, b) => b.localeCompare(a))
  for (const day of dayKeys) {
    if (day > todayKey) continue // 未来键（手工编辑）：不展示也不入合计
    if (cutoffKey !== undefined && day < cutoffKey) continue // 窗口外
    const buckets = days.get(day)
    if (buckets === undefined || buckets.size === 0) continue
    // ── 一天的桶 → 四级聚合树（复用与内存版相同的两级收尾模式）──
    const dayTotals = emptyTotals()
    const channelMap = new Map<'direct' | 'gateway', Map<string, Map<string, Map<string, TokenLedgerDayBucket>>>>()
    for (const [key, bucket] of buckets) {
      const parsed = parseDayBucketKey(key)
      if (parsed === undefined) continue
      let providers = channelMap.get(parsed.channel)
      if (providers === undefined) {
        providers = new Map()
        channelMap.set(parsed.channel, providers)
      }
      const accountKey = parsed.accountId.length > 0 ? parsed.accountId : '-'
      let accounts = providers.get(parsed.provider)
      if (accounts === undefined) {
        accounts = new Map()
        providers.set(parsed.provider, accounts)
      }
      let models = accounts.get(accountKey)
      if (models === undefined) {
        models = new Map()
        accounts.set(accountKey, models)
      }
      models.set(parsed.model, bucket)
    }
    const channels: TokenLedgerChannelRow[] = [...channelMap.entries()]
      .sort(([a], [b]) => (a === 'direct' ? -1 : 1) - (b === 'direct' ? -1 : 1))
      .map(([channel, providers]) => {
        const channelTotals = emptyTotals()
        const providerRows: TokenLedgerProviderRow[] = [...providers.entries()].map(([provider, accounts]) => {
          const providerTotals = emptyTotals()
          const accountRows: TokenLedgerAccountRow[] = [...accounts.entries()].map(([accountId, models]) => {
            const accountTotals = emptyTotals()
            const modelRows: TokenLedgerModelRow[] = [...models.entries()].map(([model, bucket]) => {
              for (const k of Object.keys(bucket) as (keyof typeof bucket)[]) {
                accountTotals[k] += bucket[k] ?? 0
              }
              return { model, ...finalizeAverages(bucket) }
            }).sort((a, b) => sumTokens(b) - sumTokens(a))
            for (const k of Object.keys(accountTotals) as (keyof typeof accountTotals)[]) {
              providerTotals[k] += accountTotals[k] ?? 0
            }
            return { accountId, models: modelRows, totals: finalizeAverages(accountTotals) }
          }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
          for (const k of Object.keys(providerTotals) as (keyof typeof providerTotals)[]) {
            channelTotals[k] += providerTotals[k] ?? 0
          }
          return { provider, accounts: accountRows, totals: finalizeAverages(providerTotals) }
        }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
        // 日小计 = 其各渠道之和
        for (const k of Object.keys(channelTotals) as (keyof typeof channelTotals)[]) {
          dayTotals[k] += channelTotals[k] ?? 0
        }
        return { channel, providers: providerRows, totals: finalizeAverages(channelTotals) }
      })
    // 全局合计按**日**累加（Σ/份数直加），不是日均值的均值。
    accumulateBucket(grandTotals, dayTotals)
    historyDays.push({ day, channels, totals: finalizeAverages(dayTotals) })
  }
  return { days: historyDays, totals: finalizeAverages(grandTotals) }
}

/** 把一个**日聚合桶的合计**累加进另一个累加器（历史全局合计用）。 */
function accumulateBucket(target: AccumulatingTotals, source: AccumulatingTotals): void {
  for (const key of Object.keys(source) as (keyof typeof source)[]) {
    target[key] += source[key] ?? 0
  }
}

/** 历史视图的最大回看天数（防一次下发过大；落盘本身已有 90 天淘汰）。 */
export const TOKEN_LEDGER_HISTORY_MAX_DAYS = 90
