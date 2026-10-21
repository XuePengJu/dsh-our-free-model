/**
 * 账号渠道模型的可用性探测。
 *
 * 渠道行由各渠道 Worker 自己服务，核心的探测（src/probe.js）直连免费网关，
 * 把 `provider/model` 发过去只会得到一个关于不存在模型的裁决。这里改走与
 * 真实回合相同的 complete 路径，发一个最小请求（"ping"，max_tokens 16），
 * 判定写回共享的 availability 存储，管理页与转发口因此看到与免费车道一致的
 * 「已探测可用 · 首响应」状态。
 *
 * 判定沿用核心探测的非对称哲学：宁可留一个挤一下就能用的模型，也不冤枉它——
 * - 无错误（收到任何流帧都算）→ available
 * - 渠道明确点名该模型不可路由（400/404/422，或消息里写明不存在/不支持）→ unavailable
 * - 配额窗口 / 限流（QUOTA_EXCEEDED、429）→ throttled
 * - 凭据失效或缺失（MISSING_CREDENTIAL 等）→ needs-login（需重新登录）
 * - 其余（5xx、网络、超时、取消）一律 unknown，不移动状态
 * 归类细节见 {@link classifyChannelFailure}。
 *
 * 探测请求必须自带一条 system 前置消息：腾讯系网关（buddy / workbuddy）硬性
 * 要求首条消息是 system，否则返回 400 code 11128「first message is not system
 * prompt」（并伪装成"安全策略拦截"）。缺了它，探测对这类渠道恒拿 5xx，判定
 * 落到 unknown，管理页因此永远停在「未探测」。对其他 OpenAI 兼容渠道无影响。
 *
 * @module packages/standalone/channel-probe
 */

/** 探测用的最小 system 前置，与桌面端连通性测试保持同一口径。 */
const PROBE_SYSTEM = 'You are a helpful assistant.'

/**
 * 探测一批渠道模型行，按**渠道分组**调度。
 *
 * ## 为什么不是一个全局并发数
 *
 * 渠道的额度是按账号算的：workbuddy 有 5 行、qodercn 6 行、trae 6 行，它们共享
 * 同一个账号额度。若只给一个全局并发 6，很可能把同一个账号的 6 条 ping 同时打
 * 出去，换回 429 → 这些模型被标成「限流中」——比慢更糟。所以：
 *
 * - 同一渠道内最多 `perChannel` 条在飞（默认 2，与原先全局 2 时单账号看到的
 *   压力一致，不改变对上游的礼貌程度）；
 * - 渠道与渠道之间并行跑，总在飞不超过 `concurrency`（默认 8）。
 *
 * 收益来自跨渠道并行：实测 33 行里 32 条健康行各 1–3 s，串行合计 53.6 s，
 * 按渠道并行后这部分只要 ~5–8 s。剩下的长尾是单条超时行，由 `timeoutMs`
 * 决定（默认 20 s —— 健康行最慢 3 s，20 s 已有 6 倍余量；45 s 会让一条死模型
 * 独占一个通道近一分钟，整轮被它拖住）。
 *
 * @param {object} channels - createChannelRuntime 返回的渠道运行时
 * @param {Array<{id:string}>} rows - channels.publicModelRows() 的行
 * @param {{perChannel?: number, concurrency?: number, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @param {(id: string, result: {state: string, detail?: string, latencyMs: number, ttftMs?: number}) => void} [onResult]
 * @returns {Promise<Record<string, {state: string, detail?: string, latencyMs: number, ttftMs?: number}>>}
 */
export async function probeChannelModels(channels, rows, options = {}, onResult = () => {}) {
  const { perChannel = 2, concurrency = 8, timeoutMs = 20_000, signal } = options
  const results = {}
  const groups = new Map()
  for (const row of rows) {
    const key = channelOf(row)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [row])
    else group.push(row)
  }
  // 全局名额是跨渠道共享的闸门：渠道再多，同时在飞的请求也不超过 concurrency。
  const slots = createLimiter(Math.max(1, concurrency))
  const workers = [...groups.values()].map(async group => {
    let cursor = 0
    const run = async () => {
      while (cursor < group.length) {
        const row = group[cursor++]
        const result = await slots(() => probeChannelModel(channels, row, { timeoutMs, signal }))
        results[row.id] = result
        onResult(row.id, result)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(perChannel, group.length)) }, run))
  })
  await Promise.all(workers)
  return results
}

/**
 * 一行的渠道归属：渠道模型 id 是 `渠道/模型`，取前缀即可。
 *
 * 同一渠道前缀必然落在同一个账号池里（`channels.handles()` 就是按这个前缀
 * 分流），所以按前缀分组等价于按账号分组，不会把不同账号混成一池。
 */
function channelOf(row) {
  const id = typeof row?.id === 'string' ? row.id : ''
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : id
}

/** 最简单的手写闸门：拿到名额才执行，执行完立刻让给下一个等待者。 */
function createLimiter(max) {
  let active = 0
  const waiting = []
  const release = () => {
    const next = waiting.shift()
    if (next === undefined) { active--; return }
    next()
  }
  return async task => {
    if (active >= max) await new Promise(resolve => waiting.push(resolve))
    else active++
    try { return await task() } finally { release() }
  }
}

async function probeChannelModel(channels, row, { timeoutMs, signal }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('探测超时')), timeoutMs)
  timer.unref?.()
  const relayAbort = () => controller.abort(signal?.reason ?? new Error('探测已取消'))
  signal?.addEventListener('abort', relayAbort, { once: true })
  const started = Date.now()
  let first = 0
  try {
    const outcome = await channels.complete({
      model: row.id, signal: controller.signal,
      openAi: {
        messages: [
          { role: 'system', content: PROBE_SYSTEM },
          { role: 'user', content: 'ping' },
        ],
        max_tokens: 16,
      },
    }, () => { if (!first) first = Date.now() })
    if (outcome.error !== undefined) return verdictFrom(outcome.error, started)
    return {
      state: 'available', latencyMs: Date.now() - started,
      ...(first ? { ttftMs: first - started } : {}),
    }
  } catch (error) {
    return verdictFrom(error, started)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relayAbort)
  }
}

function verdictFrom(error, started) {
  return classifyChannelFailure(error, started)
}

/**
 * 把一次渠道失败归到 availability 状态上。
 *
 * 与核心探测（`src/probe.js::stateOf`）同一套非对称哲学：只有**明确点名这个
 * 模型**的答复才判 `unavailable`，其余一律不移动状态（`unknown`）。渠道侧额外
 * 吃 `code`，因为它比 status 准，而且渠道 worker 跨边界显式透传它：
 *
 * - `QUOTA_EXCEEDED` / 429 —— 容量窗口（账号池在「候选全在限流窗口内」时抛的
 *   就是它，并附解禁时间）→ `throttled`；
 * - `MISSING_CREDENTIAL` 等凭据类 —— 需要重新登录 → `needs-login`：它既不是
 *   「模型不存在」，也不该继续挂在「未探测」上让用户反复点测试；
 * - 400 / 404 / 422 —— 渠道明确拒绝这个模型标识符 → `unavailable`；
 * - 5xx 与其它 —— `unknown`。上游自己的故障（含反代把 503 拼成
 *   "Service Unavailable"）不是对模型的裁决，读成 verdict 会把可用模型踢出清单。
 *
 * @returns {{state: string, detail: string, latencyMs: number}}
 */
export function classifyChannelFailure(error, started = Date.now()) {
  const status = error?.statusCode ?? error?.status
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = String(error?.message ?? '')
  return {
    state: stateOfChannel({ status, code, message }),
    detail: message.slice(0, 200),
    latencyMs: Date.now() - started,
  }
}

/** 渠道明确拒绝该模型标识符的状态码（与核心探测同一集合）。 */
const ROUTING_REFUSAL_STATUS = new Set([400, 404, 422])
/** 需要用户重新登录的渠道错误码。 */
const CREDENTIAL_CODES = new Set([
  'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'EXPIRED_CREDENTIAL', 'AUTH_FAILED', 'UNAUTHORIZED',
])
const CREDENTIAL_DETAIL = /no usable credential|log in (?:first|from|to)|not logged in|missing credential|credential (?:expired|invalid|missing)|请先登录|重新登录|登录已过期|未登录|(?:令牌|凭据|授权)[^\n]{0,8}(?:失效|过期|无效)/i
const NAMED_MODEL_DETAIL = /unavailable|not supported|no such model|unknown model|invalid model|not registered|does not exist|模型.{0,6}(?:不存在|未注册|不支持|未发布)/i

function stateOfChannel({ status, code, message }) {
  if (code === 'QUOTA_EXCEEDED' || status === 429) return 'throttled'
  if (CREDENTIAL_CODES.has(code) || CREDENTIAL_DETAIL.test(message)) return 'needs-login'
  const gatewayTrouble = Number.isInteger(status) && status >= 500
  if (!gatewayTrouble && NAMED_MODEL_DETAIL.test(message)) return 'unavailable'
  if (Number.isInteger(status) && ROUTING_REFUSAL_STATUS.has(status)) return 'unavailable'
  return 'unknown'
}

/**
 * 手工实测一个渠道模型。
 *
 * 与探测（{@link probeChannelModels}）共用请求口径 —— 同样的 system 前置、同样的
 * 最小 user 消息，所以腾讯系网关的「首条必须是 system」约束照样满足 —— 但判定从
 * 严：探测只问「能不能路由到」（收到任何流帧就算可用），手工测试是用户主动点的那
 * 一下，必须证明模型真的回了话。空正文或意外工具调用都算失败，否则一次空回复会
 * 被读成「可用」，比不测更误导。
 *
 * 失败一律抛错，由调用方用 {@link classifyChannelFailure} 归类并写入存储。
 *
 * @param {object} channels - createChannelRuntime 返回的渠道运行时
 * @param {string} id - 渠道模型行 id（`provider/model`）
 * @param {{signal?: AbortSignal, timeoutMs?: number, now?: () => number}} [options]
 * @returns {Promise<{totalMs: number, latencyMs: number, ttftMs: number, text: string, sample: string}>}
 */
export async function testChannelModel(channels, id, { signal, timeoutMs = 300_000, now = Date.now } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('实测超时')), timeoutMs)
  timer.unref?.()
  const relayAbort = () => controller.abort(signal?.reason ?? new Error('实测已取消'))
  if (signal?.aborted) relayAbort()
  else signal?.addEventListener('abort', relayAbort, { once: true })
  const started = now()
  let first = 0
  try {
    const outcome = await channels.complete({
      model: id, signal: controller.signal,
      openAi: {
        messages: [
          { role: 'system', content: PROBE_SYSTEM },
          { role: 'user', content: 'Reply with exactly: OK' },
        ],
        max_tokens: 32,
      },
    }, () => { if (!first) first = now() })
    const failure = outcome?.error
    if (failure !== undefined && failure !== null && String(failure).trim() !== '') {
      throw Object.assign(new Error(String(failure)), { channelVerdict: true })
    }
    if (Array.isArray(outcome?.toolCalls) && outcome.toolCalls.length > 0) {
      throw Object.assign(new Error('实测返回了意外的工具调用'), { channelVerdict: true })
    }
    const text = typeof outcome?.text === 'string' ? outcome.text : ''
    if (text.trim() === '') throw Object.assign(new Error('实测没有返回任何正文'), { channelVerdict: true })
    const ended = now()
    return {
      totalMs: ended - started, latencyMs: ended - started,
      ttftMs: first === 0 ? ended - started : first - started,
      text: text.slice(0, 2000), sample: text.slice(0, 60),
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relayAbort)
  }
}
