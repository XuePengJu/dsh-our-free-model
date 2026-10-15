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
 * 探测一批渠道模型行，并发与核心探测保持同样的小扇出。
 *
 * @param {object} channels - createChannelRuntime 返回的渠道运行时
 * @param {Array<{id:string}>} rows - channels.publicModelRows() 的行
 * @param {{concurrency?: number, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @param {(id: string, result: {state: string, detail?: string, latencyMs: number, ttftMs?: number}) => void} [onResult]
 * @returns {Promise<Record<string, {state: string, detail?: string, latencyMs: number, ttftMs?: number}>>}
 */
export async function probeChannelModels(channels, rows, options = {}, onResult = () => {}) {
  const { concurrency = 2, timeoutMs = 45000, signal } = options
  const results = {}
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, rows.length)) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++]
      const result = await probeChannelModel(channels, row, { timeoutMs, signal })
      results[row.id] = result
      onResult(row.id, result)
    }
  })
  await Promise.all(workers)
  return results
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
