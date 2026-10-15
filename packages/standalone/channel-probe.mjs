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
 * - 404 是渠道明确说模型不存在或已停用 → unavailable
 * - 429 是容量窗口 → throttled
 * - 其余（5xx、网络、超时、取消）一律 unknown，不移动状态
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
  const status = error?.statusCode ?? error?.status
  const state = status === 404 ? 'unavailable'
    : status === 429 ? 'throttled'
    : 'unknown'
  return {
    state,
    detail: String(error?.message ?? '').slice(0, 200),
    latencyMs: Date.now() - started,
  }
}
