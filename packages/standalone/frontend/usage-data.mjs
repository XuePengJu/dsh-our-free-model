/**
 * 用量与路由页的**纯计算层**（批次 2）。
 *
 * 这个文件不 import React、不碰 DOM、不发请求 —— 全部是「输入 → 输出」的纯函数，
 * 因此可以 `node --input-type=module` 直接断言，也可以用假数据构造边界用例。
 *
 * ## 为什么聚合放在前端而不是 management.mjs
 *
 * `/usage/ledger` 只做「解信封 + 原样转发」：worker 侧 `readTokenLedger` 聚合的是
 * **内存账本全部 500 条**，没有日期维度；而页面上的「今日 / 近 7 天 / 近 30 天」
 * 必须由 `utc8DayKey` 重新切分。把这一步放前端有两个好处：
 * 1. 纯函数可单测（服务端跑不起来也能验口径）；
 * 2. 切档不发请求（切「今日 / 全部」纯本地重算，不惊动 worker 线程）。
 *
 * ## 口径铁律（与 vendor/channel-pack/src/token-ledger.ts 逐字对齐）
 *
 * - 均值一律 **Σ / 份数**：父级平均必须由「全部样本的 Σ ÷ 份数」算出，
 *   不能拿子级已经平均过的值再求平均（3 笔 100ms 与 1 笔 200ms 分别是
 *   150 与 125，先平均再平均得 150 → 错）。
 * - 「缺失 ≠ 0」：`avgTtftMs` / `avgTps` / 桶内 `tps` 没有样本时**省略字段 / 给 null**，
 *   绝不给 0（0 tok/s 与「测不到」是两件完全不同的事）。
 * - 只有 `usageReported === true` 的请求才计入 token 汇总（失败行写 0 会把
 *   「没收到用量」混进「真的用了 0」）。
 */

/** 日趋势使用本地自然日；累计指标始终由服务端累计字段提供。 */
export function usageDays(series, count = 14, now = new Date()) {
  const values = new Map(series.map(row => [row.day, row.total]))
  const today = new Date(now)
  today.setHours(12, 0, 0, 0)
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(today)
    at.setDate(at.getDate() - count + 1 + index)
    const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    return { day, total: values.get(day) ?? 0 }
  })
}

/** 视图查询不修改统计；每页 20 条，刷新或筛选后限制在有效页码内。 */
export function usageModels(models, { search = '', sort = 'calls', page = 1 } = {}) {
  const query = search.trim().toLocaleLowerCase()
  const matches = models.filter(row => `${row.name} ${row.model}`.toLocaleLowerCase().includes(query))
  const tie = (a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.model.localeCompare(b.model)
  matches.sort((a, b) => {
    if (sort === 'name') return tie(a, b)
    const value = row => sort === 'tokens' ? row.input + row.output : sort === 'failedTurns' ? row.failedTurns : row.calls
    return value(b) - value(a) || tie(a, b)
  })
  const pages = Math.max(1, Math.ceil(matches.length / 20))
  const current = Math.min(pages, Math.max(1, Number.isSafeInteger(page) ? page : 1))
  return { total: matches.length, pages, page: current, rows: matches.slice((current - 1) * 20, current * 20) }
}

// ===========================================================================
// UTC+8 日界
// ===========================================================================

/**
 * **UTC+8 日键**（`YYYY-MM-DD`）。
 *
 * 与 `vendor/channel-pack/src/token-ledger.ts#utc8DayKey` 逐字同算法：先给时间戳
 * 加 8 小时，再取 **UTC** 年月日。前端 import 不到 vendor 的实现（它随
 * `build-standalone-channels` 打进了 worker 侧的 `business.mjs`），所以这里
 * 必须有一份镜像 —— 两边算出不同的日键，「今日」就会差一整天。
 *
 * ⚠️ **禁止**用 `new Date(ts + 8 * 3600e3).toISOString().slice(0, 10)`：
 * 1. `toISOString()` 对越界时间戳抛 `RangeError`（脏 ts 会炸整个渲染）；
 * 2. 语义上它截的是 UTC 日期，与「+8h 后再取 UTC 日期」在跨零点时**不等价**
 *    （差一天），是这条纪律最容易被踩破的地方。
 *
 * @param {number} ts 毫秒时间戳（原始时刻，**不要**先做 +8h 平移再传）。
 * @returns {string} `YYYY-MM-DD`；非有限时间戳返回 `''`。
 */
export function utc8DayKey(ts) {
  const value = Number(ts)
  if (!Number.isFinite(value)) return ''
  const shifted = new Date(value + 8 * 60 * 60 * 1000)
  const ms = shifted.getTime()
  // `new Date(NaN)` / 超出 ±8.64e15 的时间戳 → Invalid Date，getUTC* 全是 NaN。
  if (!Number.isFinite(ms)) return ''
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${month}-${day}`
}

/**
 * 档位 → 「最早允许的日键」（`null` = 不限）。
 *
 * 全部按 **UTC+8 日界**换算，与渠道额度结算同一条纪律：`week` = 含今天在内
 * 的近 7 个 UTC+8 自然日，`month` = 近 30 个。用日键字符串比较而不是减 7×24h，
 * 免得「夏令时 / 本地时区」把边界推歪（日键是字典序安全的）。
 *
 * @param {'day'|'week'|'month'|'all'} range
 * @param {number} now 参考时刻（毫秒时间戳）
 * @returns {string|null} 该档最早一天的日键；`all` 档返回 `null`
 */
export function utc8RangeStartKey(range, now) {
  if (range !== 'week' && range !== 'month') return range === 'day' ? utc8DayKey(now) : null
  const days = range === 'week' ? 7 : 30
  return utc8DayKey(now - (days - 1) * 24 * 60 * 60 * 1000)
}

// ===========================================================================
// 账本：明细行（entry）→ 四级聚合树 → 页面行
// ===========================================================================

/** 非负整数钳制（与 vendor 的 `clampCount` 同语义）。 */
function count(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

/** 空累加器：均值以 Σ/份数 累加，收尾时才做除法。 */
function emptyAccumulator() {
  return {
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
}

/**
 * Σ/份数 → **只有**速率字段（`avgTtftMs` / `avgTps`），无样本时整个字段缺失。
 *
 * 区间级速率一律走这里：口径是「每笔请求的实测值做算术平均」（与 vendor
 * `finalizeAverages` 完全一致），不是「Σ输出 ÷ Σ解码时长」。
 * 后者会给长请求更大权重，算出来是另一个数（实测同一份样本：本口径 248.3，
 * 时长加权 204.9）—— 与「日志页同一条记录」和「每日档历史数字」都会对不上。
 *
 * @param {object} acc 累加器
 * @returns {{ avgTtftMs?: number, avgTps?: number }}
 */
function finalizeRate(acc) {
  return {
    ...(acc.ttftCount > 0 ? { avgTtftMs: Math.round(acc.ttftSumMs / acc.ttftCount) } : {}),
    ...(acc.tpsCount > 0 ? { avgTps: Math.round((acc.tpsSum / acc.tpsCount) * 10) / 10 } : {}),
  }
}

/** 把一条明细累加进聚合行（与 vendor `accumulate` 逐条对齐）。 */
function accumulate(acc, entry) {
  acc.requests += 1
  if (entry.usageReported === true) acc.reportedRequests += 1
  if (typeof entry.error === 'string' && entry.error.length > 0) acc.errors += 1
  // 均值样本：**只收有实测值**的请求。失败 / 秒回空（ttft 缺省）与不可测 TPS
  // 不参与 —— 它们没有测量值，混进去等于用「没测到」摊薄「测到的」。
  const ttft = Number(entry.ttftMs)
  if (Number.isFinite(ttft) && ttft > 0) {
    acc.ttftSumMs += ttft
    acc.ttftCount += 1
  }
  const tps = Number(entry.tps)
  if (Number.isFinite(tps) && tps > 0) {
    acc.tpsSum += tps
    acc.tpsCount += 1
  }
  if (entry.usageReported !== true) return
  acc.inputTokens += count(entry.inputTokens)
  acc.outputTokens += count(entry.outputTokens)
  acc.cacheReadTokens += count(entry.cacheReadTokens)
  acc.cacheWriteTokens += count(entry.cacheWriteTokens)
  acc.reasoningTokens += count(entry.reasoningTokens)
}

/** 谁烧的 token 多谁在前。 */
function sumTokens(totals) {
  return (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0)
}

/**
 * 可加字段（**只**能是这些）。
 *
 * ⚠️ `avgTps` / `avgTtftMs` **不在里面，也永远不会被跨天合并出来**：
 * 历史响应里的 `totals` 已经被 vendor 的 `finalizeAverages` 收尾过，
 * 只有均值、没有 Σ 与份数（`ttftSumMs/ttftCount/tpsSum/tpsCount` 不上线）。
 * 想在跨天层面求均值，只能拿「天均值 × 天请求数」加权 —— 那是**估算**，
 * 样本数不等时会算错（3 笔 100ms 与 1 笔 200ms 会被等权成 150ms）。
 * 这个项目因为「63 000 tok/s」那次事故定过纪律：**宁可缺，不造假**。
 * 所以区间级的速率一律由「明细样本」重算（见 {@link ledgerRateIndex}），
 * 缺样本就显示 `—`。
 */
const ADDITIVE_FIELDS = Object.freeze([
  'requests',
  'reportedRequests',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'errors',
])

/** 空计数：**只有**可加字段，没有任何均值。 */
function emptyCounts() {
  const value = {}
  for (const key of ADDITIVE_FIELDS) value[key] = 0
  return value
}

/** 把一份小计的可加字段累加进来（均值字段被显式忽略）。 */
function addCounts(target, source) {
  if (source === null || typeof source !== 'object') return target
  for (const key of ADDITIVE_FIELDS) target[key] += count(source[key])
  return target
}

/**
 * 取一份小计里的均值字段；没有样本就返回**空对象**（不是 0）。
 *
 * 取整口径与 {@link normalizeTotals} 完全一致（tps 1 位小数、ttft 毫秒整数），
 * 这样同一个节点无论从「按渠道」行还是「按模型」行渲染，显示的数字都相同。
 */
function pickRates(raw) {
  const value = {}
  if (raw === null || typeof raw !== 'object') return value
  // `undefined` / `null` 必须单独挡掉：`Number(null) === 0`，否则「没测到」会变成 0。
  if (raw.avgTps !== undefined && raw.avgTps !== null) {
    const tps = Number(raw.avgTps)
    if (Number.isFinite(tps)) value.avgTps = Math.round(tps * 10) / 10
  }
  if (raw.avgTtftMs !== undefined && raw.avgTtftMs !== null) {
    const ttft = Number(raw.avgTtftMs)
    if (Number.isFinite(ttft)) value.avgTtftMs = Math.round(ttft)
  }
  return value
}

/**
 * 按档位过滤**日聚合**（history，落盘、重启保留、无 500 条上限）。
 *
 * 日键**现算**：`utc8DayKey(now - k*86400e3)`，k = 0..(天数-1)。
 * 绝不去解析 `day` 字符串做日期算术 —— 那会在月末、时区、夏令时上错位。
 *
 * @param {Array<object>} history `/usage/ledger` 的 `history`（`[{ day, channels, totals }]`）
 * @param {{ range?: 'day'|'week'|'month'|'all', now?: number }} options
 * @returns {Array<object>} 过滤后的天数组（保持原顺序）
 */
export function ledgerDaysInRange(history, { range = 'all', now = Date.now() } = {}) {
  const list = Array.isArray(history) ? history : []
  if (range === 'all') return list.slice()
  const span = range === 'week' ? 7 : range === 'month' ? 30 : 1
  const wanted = new Set()
  for (let index = 0; index < span; index += 1) wanted.add(utc8DayKey(now - index * 24 * 60 * 60 * 1000))
  return list.filter(entry => wanted.has(String(entry?.day ?? '')))
}

/**
 * 多天 → 单棵 `channel → provider → account → model` 树（**只累加可加字段**）。
 *
 * 它取代了批次 2 首版「用内存 500 条环重聚合」的做法：那版在账本超过 500 条
 * 之后会静默少算（实测「全部」档少了 34 倍），今日档在忙日也会截断。
 * 现在计数与 Token 一律来自落盘日聚合，速率另算（{@link ledgerRateIndex}）。
 *
 * 输出结构与 worker 侧 `readTokenLedger().channels` **形状一致**（同序、同
 * `-` 未归属桶、同排序），差别只在 `totals` **没有** `avgTps` / `avgTtftMs`。
 *
 * @param {Array<object>} days `ledgerDaysInRange()` 的结果
 * @returns {{ channels: Array<object>, totals: object }} 合并后的树与全局小计
 */
export function mergeLedgerDays(days) {
  const list = Array.isArray(days) ? days : []
  /** channel → provider → account → model → counts */
  const channelMap = new Map()
  const totals = emptyCounts()
  for (const day of list) {
    const channels = Array.isArray(day?.channels) ? day.channels : []
    for (const channel of channels) {
      const channelId = channel?.channel === 'gateway' ? 'gateway' : 'direct'
      const providers = Array.isArray(channel?.providers) ? channel.providers : []
      for (const provider of providers) {
        const providerId = String(provider?.provider ?? '')
        const accounts = Array.isArray(provider?.accounts) ? provider.accounts : []
        for (const account of accounts) {
          // 空账号统一落 `'-'` 桶（vendor 同约定）：它是真实存在的分组（「未归属」），
          // 不能并进任何一个真实账号。
          const accountId = String(account?.accountId ?? '') || '-'
          const models = Array.isArray(account?.models) ? account.models : []
          for (const row of models) {
            const modelId = String(row?.model ?? '')
            let providerMap = channelMap.get(channelId)
            if (providerMap === undefined) { providerMap = new Map(); channelMap.set(channelId, providerMap) }
            let accountMap = providerMap.get(providerId)
            if (accountMap === undefined) { accountMap = new Map(); providerMap.set(providerId, accountMap) }
            let modelMap = accountMap.get(accountId)
            if (modelMap === undefined) { modelMap = new Map(); accountMap.set(accountId, modelMap) }
            let bucket = modelMap.get(modelId)
            if (bucket === undefined) { bucket = emptyCounts(); modelMap.set(modelId, bucket) }
            addCounts(bucket, row)
          }
        }
      }
    }
    // 全局小计按**天**累加（与 vendor `readTokenLedgerHistory` 的 grandTotals 同算法），
    // 这样「全部」档的合计与端点里的 `historyTotals` 逐字段相等。
    addCounts(totals, day?.totals)
  }

  // `direct` 在前（宿主对话是主视角），同一级按 token 降序。
  const channels = [...channelMap.entries()]
    .sort(([a], [b]) => (a === 'direct' ? 0 : 1) - (b === 'direct' ? 0 : 1))
    .map(([channel, providerMap]) => {
      const channelTotals = emptyCounts()
      const providerRows = [...providerMap.entries()].map(([provider, accountMap]) => {
        const providerTotals = emptyCounts()
        const accountRows = [...accountMap.entries()].map(([accountId, modelMap]) => {
          const accountTotals = emptyCounts()
          const modelRows = [...modelMap.entries()].map(([model, bucket]) => {
            addCounts(accountTotals, bucket)
            return { model, ...bucket }
          }).sort((a, b) => sumTokens(b) - sumTokens(a))
          addCounts(providerTotals, accountTotals)
          return { accountId, models: modelRows, totals: accountTotals }
        }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
        addCounts(channelTotals, providerTotals)
        return { provider, accounts: accountRows, totals: providerTotals }
      }).sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
      return { channel, providers: providerRows, totals: channelTotals }
    })

  return { channels, totals }
}

/**
 * 把一份**日聚合**小计原样搬进输出结构：可加字段复制，均值字段**有才带**。
 *
 * 与 {@link addCounts} 的唯一区别就是末尾那几行均值 —— 那个函数用于**跨天累加**，
 * 均值必须丢掉（见 `ADDITIVE_FIELDS` 的说明）；这里用于**单日直通**，均值是
 * vendor 在当天真实样本上已经算准的，丢掉才是损失。
 *
 * @param {any} raw 日聚合树里任意一层的小计（day / channel / provider / account / model）
 * @returns {object} 可加字段齐全 + 均值按需存在的小计
 */
function dayTotals(raw) {
  const value = emptyCounts()
  if (raw === null || typeof raw !== 'object') return value
  addCounts(value, raw)
  return Object.assign(value, pickRates(raw))
}

/**
 * 单日 → 与 {@link mergeLedgerDays} **同形**的树，但均值字段保留。
 *
 * 为什么单日可以直通而多天不行：落盘日聚合里**每一个节点**（day / channel /
 * provider / account / model）都带自己的 `avgTps` / `avgTtftMs`，它们是 vendor
 * 在该节点**自己的样本**上按「每笔实测值算术平均」收尾出来的真值。单日不存在
 * 跨天加权，所以搬过来就是精确值；多天必须 Σ 了再平均，而 Σ 与份数没暴露，
 * 只能加权估算 —— 那是另一条路（明细样本重算）。
 *
 * 收益：「今天超过 500 条」那天，「每日」档仍然是**全量精确**，而不是静默
 * 降级成「最近 500 次」。今天两者恰好相等（89 条 < 500），所以看不出变化，
 * 属于纯收益。
 *
 * @param {object} day `history` 里的一天（`{ day, channels, totals }`）
 * @returns {{ channels: Array<object>, totals: object }}
 */
function treeFromSingleDay(day) {
  const channels = (Array.isArray(day?.channels) ? day.channels : [])
    .map(channel => {
      const channelId = channel?.channel === 'gateway' ? 'gateway' : 'direct'
      const providers = (Array.isArray(channel?.providers) ? channel.providers : [])
        .map(provider => {
          const accounts = (Array.isArray(provider?.accounts) ? provider.accounts : [])
            .map(account => {
              const models = (Array.isArray(account?.models) ? account.models : [])
                .map(row => ({ model: String(row?.model ?? ''), ...dayTotals(row) }))
                .sort((a, b) => sumTokens(b) - sumTokens(a))
              // 空账号统一落 `'-'` 桶（与 `mergeLedgerDays` / vendor 同约定）。
              return {
                accountId: String(account?.accountId ?? '') || '-',
                models,
                totals: dayTotals(account?.totals),
              }
            })
            .sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
          return { provider: String(provider?.provider ?? ''), accounts, totals: dayTotals(provider?.totals) }
        })
        .sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
      return { channel: channelId, providers, totals: dayTotals(channel?.totals) }
    })
    // `direct` 在前（宿主对话是主视角），与 `mergeLedgerDays` 同序。
    .sort((a, b) => (a.channel === 'direct' ? 0 : 1) - (b.channel === 'direct' ? 0 : 1))
  return { channels, totals: dayTotals(day?.totals) }
}

/**
 * 区间内的天数组 → 一棵树：**单日直通、多天合并**。
 *
 * 判断只按「区间内落到了几天」：`range === 'day'` 正常就是 1 天（`utc8DayKey(now)`
 * 那一天）。万一 history 里同一天出现两条（脏数据/重复写入），长度不是 1，
 * 就退回 `mergeLedgerDays` —— 宁可丢掉均值（显示 `—`），也不把两条的均值
 * 混成一个假的精确值。
 *
 * @param {Array<object>} days `ledgerDaysInRange()` 的结果
 * @returns {{ channels: Array<object>, totals: object, singleDay: boolean }}
 *   `singleDay` 为真时 `totals` / 各级 `totals` 里带 vendor 精确均值
 */
export function ledgerTreeForDays(days) {
  const list = Array.isArray(days) ? days : []
  if (list.length === 1 && list[0] !== null && typeof list[0] === 'object') {
    return Object.assign(treeFromSingleDay(list[0]), { singleDay: true })
  }
  return Object.assign(mergeLedgerDays(list), { singleDay: false })
}

/** 账本明细的日键（复用 {@link utc8DayKey}，非法 ts 返回 `''` 并被所有档位排除）。 */
function entryDayKey(entry) {
  return utc8DayKey(entry?.ts)
}
/**
 * 按档位过滤明细（UTC+8 日界）。
 *
 * `all` 档原样返回；`day` 取「与 now 同一日键」；`week` / `month` 取
 * 「日键 >= 最早那天的日键」（含今天）。日键为 `''` 的脏记录在非 `all` 档一律排除。
 *
 * @param {Array<object>} entries
 * @param {{ range?: 'day'|'week'|'month'|'all', now?: number }} options
 * @returns {Array<object>}
 */
export function ledgerEntriesInRange(entries, { range = 'all', now = Date.now() } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const startKey = utc8RangeStartKey(range, now)
  if (startKey === null) return list.slice()
  return list.filter(entry => {
    const key = entryDayKey(entry)
    return key !== '' && key >= startKey
  })
}

/**
 * 区间内的**速率索引**（`avgTps` / `avgTtftMs`）—— 唯一的速率来源。
 *
 * 计数与 Token 走落盘日聚合（全量、无上限），速率只能走**明细样本**：
 * 日聚合没有暴露 Σ 与份数，跨天求均值只能靠加权，而加权就是估算。
 * 所以这里只对「窗口内真的有样本」的键输出均值，其余键**整个字段缺失**，
 * UI 显示 `—`（不可测 ≠ 0 tok/s）。
 *
 * 三份索引：
 * - `total`：全窗口（合计行用）；
 * - `rows`：键 `channel:provider`（明细表「按渠道」行用）；
 * - `models`：键为模型名（明细表「按模型」行用，跨渠道合并）。
 *
 * @param {Array<object>} entries 账本明细（`snapshot.entries`）
 * @param {{ range?: 'day'|'week'|'month'|'all', now?: number }} [options]
 * @returns {{ total: object, rows: Map<string, object>, models: Map<string, object>, count: number, oldestTs: number }}
 */
export function ledgerRateIndex(entries, { range = 'all', now = Date.now() } = {}) {
  const inRange = ledgerEntriesInRange(entries, { range, now })
  const total = emptyAccumulator()
  const rows = new Map()
  const models = new Map()
  let oldestTs = Number.POSITIVE_INFINITY
  const bucketOf = (map, key) => {
    let acc = map.get(key)
    if (acc === undefined) { acc = emptyAccumulator(); map.set(key, acc) }
    return acc
  }
  for (const entry of inRange) {
    if (entry === null || typeof entry !== 'object') continue
    const channel = entry.channel === 'gateway' ? 'gateway' : 'direct'
    const provider = String(entry.provider ?? '')
    // 与 `ledgerModelRows` 的展示键保持同一套归一化（空模型名 → 未知模型），
    // 否则「按模型」视图会有一行永远拿不到速率。
    const model = String(entry.model ?? '') || '未知模型'
    const ts = Number(entry.ts)
    if (Number.isFinite(ts) && ts < oldestTs) oldestTs = ts
    accumulate(total, entry)
    accumulate(bucketOf(rows, `${channel}:${provider}`), entry)
    accumulate(bucketOf(models, model), entry)
  }
  const rateMap = source => {
    const out = new Map()
    for (const [key, acc] of source) out.set(key, finalizeRate(acc))
    return out
  }
  return {
    total: finalizeRate(total),
    rows: rateMap(rows),
    models: rateMap(models),
    count: inRange.length,
    oldestTs: Number.isFinite(oldestTs) ? oldestTs : 0,
  }
}

/**
 * 区间内每渠道**最后使用**的模型索引 —— 「主力模型」列旁的「最近」小字的来源。
 *
 * 键与 `ledgerRateIndex().rows` 完全一致（`channel:provider`），值为
 * `{ model, ts }`。「主力模型」是区间 token 王（走落盘聚合，没有时间戳），
 * 「最后用了谁」只能走**明细样本**（内存 500 条环，最新在前）。
 * 明细没有的渠道**不补字段** —— 小字不显示，绝不拿聚合猜一个。
 *
 * @param {Array<object>} entries 账本明细（`snapshot.entries`，最新在前）
 * @param {{ range?: 'day'|'week'|'month'|'all', now?: number }} [options]
 * @returns {Map<string, {model: string, ts: number}>}
 */
export function ledgerRecentIndex(entries, { range = 'all', now = Date.now() } = {}) {
  const out = new Map()
  // `ledgerEntriesInRange` 保持原顺序（最新在前），所以每个键第一次出现即最近一笔。
  for (const entry of ledgerEntriesInRange(entries, { range, now })) {
    if (entry === null || typeof entry !== 'object') continue
    const channel = entry.channel === 'gateway' ? 'gateway' : 'direct'
    const provider = String(entry.provider ?? '')
    const key = `${channel}:${provider}`
    if (out.has(key)) continue
    out.set(key, { model: String(entry.model ?? '') || '未知模型', ts: Number(entry.ts) || 0 })
  }
  return out
}

/** 渠道 id → 展示名。 */
export const CHANNEL_NAMES = Object.freeze({ direct: '直连对话', gateway: '兼容网关' })

/**
 * 渠道静态元信息（名称 / 头像字母 / 品牌色）。
 *
 * 这是**展示常量**不是假数据：品牌色不随主题变化。
 * 键与配色逐一取自仓库里的官方渠道表（`ofm-provider-list` 的 `providers[]`，
 * 渠道页左列表用的就是它），**不要凭印象改** —— 少一个 id 就会掉进兜底散列色，
 * 页面上表现为「同一个 WorkBuddy 在渠道页是蓝色、在用量页是紫色」。
 */
export const PROVIDER_META = Object.freeze({
  buddy: { name: 'WorkBuddy 国内版', short: 'W', accent: '#0A7AFF' },
  workbuddy: { name: 'WorkBuddy 国际版', short: 'W', accent: '#0B63CE' },
  qoder: { name: 'Qoder', short: 'Q', accent: '#615CED' },
  qwenwork: { name: '千问办公 QwenWork', short: '千', accent: '#7C3AED' },
  qodercn: { name: 'Qoder 中国版', short: 'Q', accent: '#7A6CF0' },
  trae: { name: 'TRAE', short: 'T', accent: '#00BFA6' },
  minimax: { name: 'MiniMax Code', short: 'M', accent: '#E4007F' },
  lobsterai: { name: 'LobsterAI', short: 'L', accent: '#FF6A00' },
  codearts: { name: 'CodeArts', short: 'C', accent: '#C7000B' },
  loomy: { name: 'Loomy', short: 'L', accent: '#2F6BFF' },
  raccoon: { name: 'Raccoon', short: 'R', accent: '#00A6A6' },
  zcode: { name: 'ZCode', short: 'Z', accent: '#3B6EF6' },
  gemini: { name: 'Gemini', short: 'G', accent: '#4285F4' },
  cline: { name: 'Cline', short: 'C', accent: '#5B5BD6' },
})

/** 未知渠道的兜底配色（按 id 稳定散列，同一渠道永远同一个颜色）。 */
const FALLBACK_ACCENTS = ['#615CED', '#00BFA6', '#E4007F', '#3B6EF6', '#C7000B', '#0A7AFF']

/**
 * 取渠道展示元信息；未知 id 用**确定性**兜底（同 id 同色，刷新不闪）。
 *
 * @param {string} provider provider id（`qoder` / `codearts` / …）
 * @returns {{ name: string, short: string, accent: string }}
 */
export function providerMeta(provider) {
  const id = String(provider ?? '')
  const known = PROVIDER_META[id]
  if (known !== undefined) return known
  if (id === '') return { name: '未知渠道', short: '?', accent: '#8A93A6' }
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  return {
    name: id.charAt(0).toUpperCase() + id.slice(1),
    short: id.charAt(0).toUpperCase(),
    accent: FALLBACK_ACCENTS[hash % FALLBACK_ACCENTS.length],
  }
}

/** 空小计：所有计数 0，均值字段**缺失**（≠ 0）。 */
export const emptyLedgerTotals = () => ({
  requests: 0,
  reportedRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  errors: 0,
})

/**
 * 归一化 RPC 给的小计：缺字段补 0，均值缺样本时**保持缺失**。
 *
 * 服务端在「账本为空」时给的 `totals` 是 `{}`（management 端点的兜底），
 * 直接读字段会得到一堆 `undefined`，表格里渲染成 `NaN`。
 */
export function normalizeTotals(raw) {
  const base = emptyLedgerTotals()
  if (raw === null || typeof raw !== 'object') return base
  for (const key of Object.keys(base)) base[key] = count(raw[key])
  const ttft = Number(raw.avgTtftMs)
  if (Number.isFinite(ttft) && raw.avgTtftMs !== undefined && raw.avgTtftMs !== null) base.avgTtftMs = Math.round(ttft)
  const tps = Number(raw.avgTps)
  if (Number.isFinite(tps) && raw.avgTps !== undefined && raw.avgTps !== null) base.avgTps = Math.round(tps * 10) / 10
  return base
}

/**
 * 四级树 → 明细表「按渠道」行（一行 = 一个 channel|provider 组合）。
 *
 * @param {Array<object>} channels `ledgerTreeForDays()` 的渠道行
 * @returns {Array<object>} `ChannelRow[]`（按 token 降序，带请求占比）
 */
export function ledgerAccountRows(channels) {
  const list = Array.isArray(channels) ? channels : []
  // 占比分母：全部渠道的 token 合计（同一个数给所有行用，避免逐行重算）。
  let grand = 0
  for (const channel of list) grand += sumTokens(channel?.totals ?? {})
  const rows = []
  for (const channel of list) {
    const channelId = channel?.channel === 'gateway' ? 'gateway' : 'direct'
    const providers = Array.isArray(channel?.providers) ? channel.providers : []
    for (const provider of providers) {
      const providerId = String(provider?.provider ?? '')
      const meta = providerMeta(providerId)
      const accounts = Array.isArray(provider?.accounts) ? provider.accounts : []
      // `'-'` 是「未归属」分组，不是真实账号：可以贡献 token，但不计入账号数。
      const realAccounts = accounts.filter(row => String(row?.accountId ?? '') !== '-')
      let topAccountId = ''
      let topAccountRequests = -1
      let topAccountTotals = null
      for (const account of accounts) {
        const requests = count(account?.totals?.requests)
        if (requests > topAccountRequests) {
          topAccountRequests = requests
          topAccountId = String(account?.accountId ?? '')
          topAccountTotals = account?.totals ?? null
        }
      }
      // 主力模型：跨账号汇总后 token 最多的那个（同名模型在多账号下要合并）。
      const modelTotals = new Map()
      for (const account of accounts) {
        const models = Array.isArray(account?.models) ? account.models : []
        for (const row of models) {
          const model = String(row?.model ?? '')
          const tokens = sumTokens(row ?? {})
          modelTotals.set(model, (modelTotals.get(model) ?? 0) + tokens)
        }
      }
      const ranked = [...modelTotals.entries()].sort((a, b) => b[1] - a[1])
      const totals = normalizeTotals(provider?.totals)
      const tokens = sumTokens(totals)
      rows.push({
        key: `${channelId}:${providerId}`,
        channelName: CHANNEL_NAMES[channelId] ?? channelId,
        provider: providerId,
        providerName: meta.name,
        providerShort: meta.short,
        accent: meta.accent,
        accounts: realAccounts.length,
        topAccount: topAccountId === '' || topAccountId === '-' ? '未归属' : topAccountId,
        topModel: ranked.length > 0 ? ranked[0][0] : '—',
        topModels: ranked.slice(0, 3).map(([model]) => model),
        totals,
        share: grand > 0 ? Math.round((tokens / grand) * 100) : 0,
        // 账号最多者的请求数：用来在 tooltip 里说清「谁是主力账号」。
        topAccountRequests: Math.max(0, topAccountRequests),
        topAccountTokens: topAccountTotals === null ? 0 : sumTokens(normalizeTotals(topAccountTotals)),
      })
    }
  }
  rows.sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
  return rows
}

/**
 * 四级树 → 明细表「按模型」行（跨渠道、跨账号合并同名模型）。
 *
 * ⚠️ 只合并**可加字段**。速率不在这里算、也不要试图「按请求数加权回填 Σ」：
 * 输入树来自落盘日聚合，它的 `totals` 里根本没有 Σ 与份数，加权就是估算。
 * 区间级速率由 {@link ledgerRateIndex} 从明细样本重算，`ledgerView` 负责贴回来。
 *
 * `exact` 只给**单日档**用（{@link ledgerTreeForDays} 的 `singleDay`）：这时每个
 * 模型节点自带 vendor 精确均值，但**只有当该模型在当天树里只出现一次**时，节点
 * 均值才等于合并后的均值。出现两次以上（同模型跨账号/跨渠道）就得跨节点加权 =
 * 估算 —— 那种情况一律不给均值（显示 `—`），回到「宁可缺，不造假」。
 *
 * @param {Array<object>} channels `mergeLedgerDays().channels`
 * @param {{ exact?: boolean }} [options] `exact: true` 时保留单节点模型的精确均值
 * @returns {Array<object>} `ChannelModelRow[]`（按 token 降序）
 */
export function ledgerModelRows(channels, { exact = false } = {}) {
  const list = Array.isArray(channels) ? channels : []
  let grand = 0
  /** @type {Map<string, { totals: object, providers: Set<string>, accounts: Set<string>, nodes: number, rate: object|null }>} */
  const merged = new Map()
  for (const channel of list) {
    const providers = Array.isArray(channel?.providers) ? channel.providers : []
    for (const provider of providers) {
      const providerId = String(provider?.provider ?? '')
      const accounts = Array.isArray(provider?.accounts) ? provider.accounts : []
      for (const account of accounts) {
        const accountId = String(account?.accountId ?? '')
        const models = Array.isArray(account?.models) ? account.models : []
        for (const row of models) {
          const model = String(row?.model ?? '')
          let bucket = merged.get(model)
          if (bucket === undefined) {
            bucket = { totals: emptyCounts(), providers: new Set(), accounts: new Set(), nodes: 0, rate: null }
            merged.set(model, bucket)
          }
          addCounts(bucket.totals, row)
          bucket.nodes += 1
          if (exact) {
            // 第一次出现 → 记下节点自带的均值；第二次起 → 无法无偏合并，作废。
            if (bucket.nodes === 1) bucket.rate = pickRates(row)
            else bucket.rate = null
          }
          if (providerId !== '') bucket.providers.add(providerId)
          if (accountId !== '' && accountId !== '-') bucket.accounts.add(`${providerId}/${accountId}`)
        }
      }
    }
  }
  for (const bucket of merged.values()) grand += sumTokens(bucket.totals)
  const rows = [...merged.entries()].map(([model, bucket]) => {
    const totals = bucket.rate === null ? bucket.totals : Object.assign(bucket.totals, bucket.rate)
    return {
      key: `model:${model}`,
      model: model === '' ? '未知模型' : model,
      providers: bucket.providers.size,
      accounts: bucket.accounts.size,
      totals,
      share: grand > 0 ? Math.round((sumTokens(totals) / grand) * 100) : 0,
    }
  })
  rows.sort((a, b) => sumTokens(b.totals) - sumTokens(a.totals))
  return rows
}

/**
 * 明细 → 实时请求流（最新在前，最多 `limit` 行）。
 *
 * 账本明细本身就是「最新在前」，所以直接切片即可；不在这里再排一次序
 * （同毫秒多请求时稳定顺序有意义，重排会打乱）。
 *
 * @param {Array<object>} entries
 * @param {number} limit
 * @returns {Array<object>} `StreamRow[]`
 */
export function ledgerStreamRows(entries, limit = 6) {
  const list = Array.isArray(entries) ? entries : []
  const size = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 6
  return list.slice(0, size).map((entry, index) => {
    const providerId = String(entry?.provider ?? '')
    const meta = providerMeta(providerId)
    const accountId = typeof entry?.accountId === 'string' ? entry.accountId : ''
    const input = count(entry?.inputTokens)
    const output = count(entry?.outputTokens)
    const ttft = Number(entry?.ttftMs)
    const tps = Number(entry?.tps)
    return {
      key: `${entry?.ts ?? index}:${entry?.model ?? ''}:${index}`,
      at: Number.isFinite(Number(entry?.ts)) ? Number(entry.ts) : Date.now(),
      provider: meta.name,
      providerShort: meta.short,
      accent: meta.accent,
      model: String(entry?.model ?? '') || '未知模型',
      account: accountId === '' ? '未归属' : accountId,
      // 缺失即 `undefined`：UI 显示 `—`，绝不显示 0（不可测 ≠ 0 tok/s）。
      tps: Number.isFinite(tps) && tps > 0 ? tps : undefined,
      ttftMs: Number.isFinite(ttft) && ttft > 0 ? ttft : undefined,
      // 只有报过 usage 的行才有 token 数；没报的行显示 `—`。
      tokens: entry?.usageReported === true ? input + output : undefined,
      failed: typeof entry?.error === 'string' && entry.error.length > 0,
      reason: typeof entry?.error === 'string' && entry.error.length > 0 ? entry.error : undefined,
    }
  })
}

/**
 * 一个档位的完整账本视图：小计 + 明细表两个视图 + 实时流。
 *
 * 这是 `usage.tsx` 唯一需要调用的账本入口 —— 让「切档」「过滤」「聚合」
 * 三件事在同一个 `useMemo` 里完成，也保证三块区块**永远同源**。
 *
 * ## 两条数据链，各管一段（批次 2 修订）
 *
 * - **计数与 Token** ← `history`（落盘日聚合，重启保留、**没有 500 条上限**）。
 *   批次 2 首版拿内存 500 条环重聚合，「全部」档因此少了 34 倍（500 vs 17 000）。
 * - **速率**（`avgTps` / `avgTtftMs`）← 分两种：
 *   - **单日档直通**：`history` 里每个节点自带 vendor 精确均值，直接采信
 *     （见 {@link ledgerTreeForDays}），此时 `rateExact === true`，与内存上限无关；
 *   - **多天档**：日聚合没暴露 Σ 与份数，跨天求均值只能加权 = 估算，所以改用
 *     `entries ∩ range` 的明细样本重算（{@link ledgerRateIndex}）。宁可让速率只
 *     覆盖「最近 N 次请求」，也不回填历史均值（见 `ADDITIVE_FIELDS` 的说明）。
 *     调用方据此在列头上标 ⓘ、并在窗口打满时给出灰字提示。
 *
 * @param {Array<object>|null} history `/usage/ledger` 的 `history`（`[{ day, channels, totals }]`）
 * @param {Array<object>|null} entries `/usage/ledger` 的 `snapshot.entries`（最新在前）
 * @param {{ range?: 'day'|'week'|'month'|'all', now?: number, streamLimit?: number }} [options]
 *   档位 / 参考时刻 / 实时流行数
 * @returns {{ totals: any, accountRows: any[], modelRows: any[], streamRows: any[], channels: any[], entryCount: number, windowCount: number, windowSaturated: boolean, rateExact: boolean }}
 *   `totals` 是**当前档位**的小计；`accountRows` / `modelRows` 已含占比、速率与排序；
 *   `streamRows` 是最新在前的若干条（已映射成组件要的形态）。
 *   `rateExact`：速率是**区间全量精确值**（单日直通），此时 `windowSaturated` 必为 false；
 *   `windowSaturated`：速率样本已经撞到内存上限（500 条），速率列**不代表区间全量**。
 */
export function ledgerView(history, entries, { range = 'all', now = Date.now(), streamLimit = 6 } = {}) {
  const tree = ledgerTreeForDays(ledgerDaysInRange(history, { range, now }))
  // 单日档不走样本重算：树里每个节点的均值都是 vendor 在当天精确 finalize 出来的，
  // 拿 500 条明细去覆盖它反而是把精确值降级成抽样值。
  const rates = tree.singleDay ? null : ledgerRateIndex(entries, { range, now })
  // 「最近使用」任何档位都走明细（聚合没有逐笔时间戳）；单日档 rates 为 null 也要贴。
  const recents = ledgerRecentIndex(entries, { range, now })

  // 速率按行键贴回；窗口里没有该行的样本时**不补字段**（UI 显示 `—`）。
  const accountRows = ledgerAccountRows(tree.channels).map(row => ({
    ...(rates === null ? row : { ...row, totals: { ...row.totals, ...(rates.rows.get(row.key) ?? {}) } }),
    recentModel: recents.get(row.key)?.model,
    recentTs: recents.get(row.key)?.ts,
  }))
  const modelRows = ledgerModelRows(tree.channels, { exact: tree.singleDay }).map(row => (
    rates === null ? row : { ...row, totals: { ...row.totals, ...(rates.models.get(row.model) ?? {}) } }
  ))
  const totals = rates === null ? tree.totals : { ...tree.totals, ...rates.total }

  // 速率样本是否撞到 500 条上限 = 条数达上限 **且** 最旧一条仍落在所选窗口内
  // （否则「更早的样本本来就不在窗口里」，没被截断）。单日直通档不存在截断。
  const cap = 500
  const sampleCount = rates === null ? 0 : rates.count
  const startKey = utc8RangeStartKey(range, now)
  const oldestKey = rates === null ? '' : utc8DayKey(rates.oldestTs)
  const windowSaturated = rates !== null
    && sampleCount >= cap
    && oldestKey !== ''
    && (startKey === null || oldestKey >= startKey)

  return {
    totals,
    accountRows,
    modelRows,
    streamRows: ledgerStreamRows(ledgerEntriesInRange(entries, { range, now }), streamLimit),
    channels: tree.channels,
    entryCount: sampleCount,
    windowCount: sampleCount,
    windowSaturated,
    rateExact: rates === null,
  }
}

// ===========================================================================
// 双轴图：按时间分桶
// ===========================================================================

/**
 * 把 `/stats` 的逐条样本切成定宽时间桶（Token 柱 + tok/s 折线）。
 *
 * 桶内 token = **Σ(input + output)**；桶内速度 = **Σ decodeTokens ÷ Σ decodeMs**
 * —— 对时间窗口求整体速率，而不是把每笔请求的 tps 再平均（后者会让
 * 「10 笔 200 tok/s 的短请求」和「1 笔 20 tok/s 的长请求」等权，读出虚高数字）。
 *
 * 空桶（窗口内没有任何样本）的 `tps` 给 **`null`**：图上断线，**不画 0**。
 * 给 0 会画出一条贴底的假折线，读者会以为「那个时刻速度掉到 0」。
 *
 * @param {Array<object>} samples `/stats` 的 `samples`（`{ at, input, output, decodeMs, decodeTokens }`）
 * @param {{ now?: number, windowMs?: number, buckets?: number }} options
 * @returns {{ tokens: number[], tps: (number|null)[], bucketMs: number, from: number, peak: number }}
 */
export function bucketSamples(samples, { now = Date.now(), windowMs = 60 * 60 * 1000, buckets = 30 } = {}) {
  const list = Array.isArray(samples) ? samples : []
  const span = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60 * 60 * 1000
  const count2 = Number.isFinite(buckets) && buckets > 0 ? Math.trunc(buckets) : 30
  const bucketMs = span / count2
  // 起点对齐到桶边界：同 2 分钟内多次渲染（5 秒一轮询）不会让整张图横向抖动。
  const from = Math.floor((now - span) / bucketMs) * bucketMs
  const tokens = new Array(count2).fill(0)
  const decodeMsSum = new Array(count2).fill(0)
  const decodeTokensSum = new Array(count2).fill(0)
  for (const sample of list) {
    const at = Number(sample?.at)
    if (!Number.isFinite(at) || at < from) continue
    const index2 = Math.floor((at - from) / bucketMs)
    if (index2 < 0) continue
    // 落在「最后一个桶之后」（时钟轻微超前）的样本并入最后一桶，不丢弃。
    const slot = index2 >= count2 ? count2 - 1 : index2
    tokens[slot] += count(sample?.input) + count(sample?.output)
    const decodeMs = Number(sample?.decodeMs)
    const decodeTokens = Number(sample?.decodeTokens)
    // 服务端只对「可测」的行填 decodeMs/decodeTokens（其余写 0），
    // 所以这里加 0 不会摊薄比值。
    if (Number.isFinite(decodeMs) && decodeMs > 0 && Number.isFinite(decodeTokens) && decodeTokens > 0) {
      decodeMsSum[slot] += decodeMs
      decodeTokensSum[slot] += decodeTokens
    }
  }
  const tps = decodeMsSum.map((ms, index2) => (ms > 0
    ? Math.round((decodeTokensSum[index2] / (ms / 1000)) * 10) / 10
    : null))
  const peak = tokens.reduce((max, value) => (value > max ? value : max), 0)
  return { tokens, tps, bucketMs, from, peak }
}

/**
 * 取某条组合链**最近一个回合**的走查记录。
 *
 * 分组键是行里的 `turnAt`（回合起点，同回合每一行都相同）——绝不按 `at`
 * 的时间接近去猜：猜出来的「同一次请求」就是编造。行数据来自
 * `GET /api/management/usage/attempts`（后端 `src/core/attempts.js`）。
 *
 * @param {unknown} attempts - 尝试环数组（最新在前，但这里不依赖顺序）
 * @param {{chainId?: string}} [options] - `chainId` 为空串时直接返回 null
 *   （没配模型组的页面不该显示任何走查）
 * @returns {{turnAt: number, rows: AttemptRow[]} | null}
 *   `rows` 按 `index` 升序；输入不是数组、链没走过时返回 `null`。
 */
export function latestChainTurn(attempts, { chainId } = {}) {
  if (!Array.isArray(attempts) || chainId === undefined || chainId === null || chainId === '') return null
  /** @typedef {{turnAt: number, at: number, chainId: string, chainName: string, index: number, candidateId: string, outcome: 'hit'|'skipped'|'aborted', reason: string, elapsedMs: number}} AttemptRow */
  /** @type {null | {turnAt: number, rows: AttemptRow[]}} */
  let best = null
  for (const row of attempts) {
    if (row === null || typeof row !== 'object') continue
    if (row.chainId !== chainId) continue
    // 老文件没有 turnAt：退回行自己的 `at`（每行独占一组，不冒充同回合）。
    const turnAt = Number.isFinite(row.turnAt) ? row.turnAt : Number(row.at)
    if (!Number.isFinite(turnAt)) continue
    if (best === null || turnAt > best.turnAt) best = { turnAt, rows: [row] }
    else if (turnAt === best.turnAt) best.rows.push(row)
  }
  if (best === null) return null
  best.rows.sort((a, b) => (Number.isFinite(a.index) ? a.index : 0) - (Number.isFinite(b.index) ? b.index : 0))
  return best
}

/**
 * 最近**真正被走过**的那条组合链 id。
 *
 * hero 以前固定取「配置里的第一条启用链」（`chains[0]`），结果用户实际在用
 * 第二条链时，页面上永远显示第一条链的成员，读起来像「模型没换」。
 * 这里改成跟着事实走：谁最近有走查记录，就展示谁。
 *
 * 注意只认 `chainId`，不做任何猜测（不按成员重合度归类）；返回空串表示
 * 一次走查都没有，调用方应退回配置里的第一条。
 *
 * @param {unknown} attempts - 尝试环数组（不依赖顺序）
 * @returns {string} 最近回合的 `chainId`；无有效行时为空串
 */
export function latestActiveChainId(attempts) {
  if (!Array.isArray(attempts)) return ''
  let newest = -Infinity
  let chainId = ''
  for (const row of attempts) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.chainId === 'string' ? row.chainId : ''
    if (id === '') continue
    // 与 latestChainTurn 同一口径：老文件没有 turnAt 就退回行自己的 `at`。
    const turnAt = Number.isFinite(row.turnAt) ? row.turnAt : Number(row.at)
    if (!Number.isFinite(turnAt)) continue
    if (turnAt > newest) {
      newest = turnAt
      chainId = id
    }
  }
  return chainId
}
