/**
 * 四档时间范围（每日 / 每周 / 每月 / 全部）的服务端预聚合。
 *
 * 纯函数模块：不触碰 IO、不修改入参。唯一的数据来源是 `src/store.js` 的原始
 * stats（`days` 日桶 + `models`/`logical`/`requests` lifetime），唯一导出的聚合
 * 入口是 `buildUsagePeriods`，由 `buildStats` 调用后挂载到 `/stats` 响应。
 *
 * 口径铁律（见架构文档共享知识）：
 * - 可加和量（ttftMs/ttftSamples/decodeMs/decodeTokens）只做一次除法；
 * - `tps` 门槛 `MIN_DECODE_MS` 按"周期合并后的 ΣdecodeMs"判断，不逐日判断；
 * - P 层（物理请求）与 T 层（用户回合）绝不互填；
 * - 「全部」档 Token/请求/回合类取 lifetime，性能列与趋势图只取保留期日桶。
 *
 * @module src/core/usage-periods.js
 */

import { MIN_DECODE_MS, dayKey } from '../store.js'

/** 档位枚举唯一来源。顺序：细 → 粗，即控件从左到右的顺序。 */
export const USAGE_PERIODS = ['day', 'week', 'month', 'all']

/** 档位控件文案。 */
export const USAGE_PERIOD_LABELS = { day: '每日', week: '每周', month: '每月', all: '全部' }

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 0=周一 … 6=周日。周起始日固定为周一，不引入 ISO 周编号。 */
const weekdayOffset = date => (date.getDay() + 6) % 7

/**
 * 本地 `YYYY-MM-DD`（与 store.js 的 `dayKey` 同源：getFullYear/getMonth/getDate）。
 * 独立导出便于直接测试；实现委托 `dayKey`，避免两处日历逻辑漂移。
 */
export function localDayKey(at) {
  return dayKey(at)
}

/**
 * 档位 → 自然周期边界。纯函数，`now` 可注入。
 *
 * 周起始=周一（`(getDay()+6)%7`）；正午锚点 `setHours(12,0,0,0)` 规避跨夏令时
 * 按 24 小时回退导致的日期跳变；月固定为当月 1 号至月末。
 *
 * @param {'day'|'week'|'month'|'all'} period
 * @param {number|Date} now
 * @param {object} [stats] - 仅 `all` 档需要，用于取保留期内全部日桶键。
 * @returns {{period: string, start: string, end: string, days: string[], label: string, ongoing: boolean}}
 */
export function periodBounds(period, now, stats = {}) {
  const t = new Date(now)
  t.setHours(12, 0, 0, 0)

  const list = (from, to) => {
    const out = []
    const cursor = new Date(from)
    cursor.setHours(12, 0, 0, 0)
    const end = new Date(to)
    end.setHours(12, 0, 0, 0)
    while (cursor <= end) {
      out.push(localDayKey(cursor))
      cursor.setDate(cursor.getDate() + 1)
    }
    return out
  }

  if (period === 'day') {
    const key = localDayKey(t)
    return { period, start: key, end: key, days: [key], ongoing: true, label: `今日 · ${key}（${WEEKDAYS[t.getDay()]}）` }
  }

  if (period === 'week') {
    const mon = new Date(t)
    mon.setDate(mon.getDate() - weekdayOffset(t))
    const sun = new Date(mon)
    sun.setDate(sun.getDate() + 6)
    const start = localDayKey(mon)
    const end = localDayKey(sun)
    return { period, start, end, days: list(mon, sun), ongoing: true, label: `${start}（周一）– ${end}（周日）` }
  }

  if (period === 'month') {
    const first = new Date(t.getFullYear(), t.getMonth(), 1, 12)
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0, 12)
    return {
      period,
      start: localDayKey(first),
      end: localDayKey(last),
      days: list(first, last),
      ongoing: true,
      label: `${t.getFullYear()} 年 ${t.getMonth() + 1} 月 · ${localDayKey(first)} – ${localDayKey(last)}`,
    }
  }

  // all：无下界；D = 保留期内全部日桶。
  const keys = Object.keys(stats?.days ?? {}).sort()
  return {
    period: 'all',
    start: keys[0] ?? '',
    end: localDayKey(t),
    days: keys,
    ongoing: false,
    label: keys.length ? `累计 · 自 ${keys[0]} 起` : '累计',
  }
}

/**
 * 唯一模型行构造点：`buildStats`（all 档顶层 models）与 `aggregatePeriod`
 * （day/week/month 档 models）共用，输出键集合严格一致。
 *
 * 输入 `acc` 为已累加好的可加和量；派生值只在此算一次、只舍入一次，
 * 禁止把 ttft 与 decode 原始量透传到输出。
 *
 * @param {string} model
 * @param {object} acc - { input, output, reasoning, cacheRead, calls, failed,
 *   ttftMs, ttftSamples, decodeMs, decodeTokens, turns, failedTurns, recoveredTurns }
 * @param {Array<{id: string, name?: string}>} catalog
 */
export function toModelRow(model, acc, catalog) {
  const entry = Array.isArray(catalog) ? catalog.find(row => row?.id === model) : undefined
  return {
    model,
    name: entry?.name ?? model,
    turns: acc.turns ?? 0,
    failedTurns: acc.failedTurns ?? 0,
    recoveredTurns: acc.recoveredTurns ?? 0,
    calls: acc.calls ?? 0,
    failed: acc.failed ?? 0,
    input: acc.input ?? 0,
    output: acc.output ?? 0,
    reasoning: acc.reasoning ?? 0,
    cacheRead: acc.cacheRead ?? 0,
    avgTtftMs: (acc.ttftSamples ?? 0) > 0 ? Math.round((acc.ttftMs ?? 0) / acc.ttftSamples) : null,
    tps: (acc.decodeMs ?? 0) >= MIN_DECODE_MS ? Math.round((acc.decodeTokens ?? 0) / ((acc.decodeMs ?? 0) / 1000)) : null,
  }
}

const zeroAcc = () => ({
  input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0,
  ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
  turns: 0, failedTurns: 0, recoveredTurns: 0,
})

const dailySince = stats => {
  const since = stats?.logicalDailySince
  return typeof since === 'string' && since !== '' ? since : ''
}

/** 日/周/月档的回合数据是否可用（`logicalDailySince` 为空 → 自始完整）。 */
function turnDataAvailable(stats, bounds) {
  const since = dailySince(stats)
  if (since === '') return true
  return bounds.end >= since
}

/** 周期跨越迁移日时给出说明文案（`''` 表示无需说明）。 */
function migrationNote(stats, bounds) {
  const since = dailySince(stats)
  if (since === '') return ''
  if (bounds.end < since) return ''
  if (bounds.start <= since) return `回合数据自 ${since} 起`
  return ''
}

/** 「全部」档诚实性注脚：性能列与柱图只覆盖保留期日桶。 */
function retentionNote(bounds) {
  if (!bounds.days.length) return ''
  return `柱图与性能列仅覆盖保留期内最近 120 个自然日（${bounds.start} 起）；顶部指标卡为真实累计，不受保留期限制。`
}

/** 最近 `count` 个自然日（含今天），用于每日档的 7 日对照柱图。 */
function lastNDays(count, now) {
  const anchor = new Date(now)
  anchor.setHours(12, 0, 0, 0)
  const out = []
  for (let index = count - 1; index >= 0; index -= 1) {
    const day = new Date(anchor)
    day.setDate(day.getDate() - index)
    out.push(localDayKey(day))
  }
  return out
}

/**
 * 构造趋势图柱序列。day/week/month 按日柱（含未来日 0 + 弱化标记）；all 按
 * 自然月聚合（`key = YYYY-MM`，≤ 5 桶，边界月标记 partial）。
 */
function buildChart(byDay, period, bounds, now, total) {
  if (period === 'all') {
    const months = new Map()
    for (const key of bounds.days) {
      const month = key.slice(0, 7)
      months.set(month, (months.get(month) ?? 0) + (byDay.get(key)?.total ?? 0))
    }
    const keys = [...months.keys()].sort()
    const bars = keys.map(key => {
      const value = months.get(key) ?? 0
      const partial = key === keys[0] && !byDay.has(`${key}-01`)
      const title = partial ? `${key}（含部分保留日）· ${value} Token` : `${key} · ${value} Token`
      return { key, label: key, total: value, ...(partial ? { partial: true } : {}), title }
    })
    return { bars, total, note: retentionNote(bounds), granularity: 'month' }
  }

  const todayKey = localDayKey(now)
  const keys = period === 'day' ? lastNDays(7, now) : bounds.days
  const bars = keys.map(key => {
    const value = byDay.get(key)?.total ?? 0
    const future = key > todayKey
    const title = future ? `${key}（未到）` : `${key} · ${value} Token`
    return {
      key,
      label: key.slice(5).replace('-', '/'),
      total: value,
      ...(future ? { future: true } : {}),
      title,
    }
  })
  return { bars, total, note: '', granularity: 'day' }
}

/**
 * 「全部」档的 lifetime 指标：Token/请求/回合类取真实 lifetime，并沿用
 * `buildStats` 的"lifetime 缺失回退日桶合计"逻辑，保证与 `grand`/顶层字段一致。
 */
function lifetimeMetrics(stats, acc, dayTotals) {
  const logical = stats.logical ?? {}
  const logicalModels = logical.models ?? {}
  const logicalReady = Number.isSafeInteger(logical.turns)
  const lifetimeModels = stats.models ?? {}
  const modelIds = new Set([...acc.keys(), ...Object.keys(lifetimeModels), ...Object.keys(logicalModels)])

  let input = 0
  let output = 0
  let reasoning = 0
  let namedTurns = 0
  let namedFailedTurns = 0
  let namedRecoveredTurns = 0
  let namedFailed = 0
  for (const model of modelIds) {
    const lifetime = lifetimeModels[model] ?? {}
    const dayTotal = acc.get(model) ?? zeroAcc()
    input += Number.isSafeInteger(lifetime.input) ? lifetime.input : dayTotal.input
    output += Number.isSafeInteger(lifetime.output) ? lifetime.output : dayTotal.output
    reasoning += Number.isSafeInteger(lifetime.reasoning) ? lifetime.reasoning : dayTotal.reasoning
    namedFailed += Number.isSafeInteger(lifetime.failed) ? lifetime.failed : dayTotal.failed
    namedTurns += logicalModels[model]?.turns ?? (logicalReady ? 0 : dayTotal.calls)
    namedFailedTurns += logicalModels[model]?.failed ?? (logicalReady ? 0 : dayTotal.failed)
    namedRecoveredTurns += logicalModels[model]?.recovered ?? 0
  }

  const hasLifetimeFailures = Number.isSafeInteger(stats.failedRequests)
  return {
    turns: logicalReady ? logical.turns : namedTurns,
    failedTurns: Number.isSafeInteger(logical.failed) ? logical.failed : namedFailedTurns,
    recoveredTurns: Number.isSafeInteger(logical.recovered) ? logical.recovered : namedRecoveredTurns,
    requests: stats.requests ?? 0,
    failedRequests: hasLifetimeFailures ? stats.failedRequests : namedFailed,
    input,
    output,
    reasoning,
  }
}

/**
 * 单档聚合。纯函数，不改入参。
 *
 * @returns {{bounds, metrics, models?: object[], chart: {bars, total, note, granularity},
 *   turnsAvailable: boolean, note?: string}}
 */
export function aggregatePeriod(stats, period, catalog, now) {
  const bounds = periodBounds(period, now, stats)
  const byDay = new Map(Object.entries(stats.days ?? {}))
  const acc = new Map()
  let turns = 0
  let failedTurns = 0
  let recoveredTurns = 0

  for (const key of bounds.days) {
    const bucket = byDay.get(key)
    if (!bucket) continue
    turns += bucket.turns ?? 0
    failedTurns += bucket.failedTurns ?? 0
    recoveredTurns += bucket.recoveredTurns ?? 0
    for (const [model, row] of Object.entries(bucket.models ?? {})) {
      const s = acc.get(model) ?? zeroAcc()
      s.input += row.input ?? 0
      s.output += row.output ?? 0
      s.reasoning += row.reasoning ?? 0
      s.cacheRead += row.cacheRead ?? 0
      s.calls += row.calls ?? 0
      s.failed += row.failed ?? 0
      s.ttftMs += row.ttftMs ?? 0
      s.ttftSamples += row.ttftSamples ?? 0
      s.decodeMs += row.decodeMs ?? 0
      s.decodeTokens += row.decodeTokens ?? 0
      acc.set(model, s)
    }
    for (const [model, row] of Object.entries(bucket.modelsTurns ?? {})) {
      const s = acc.get(model) ?? zeroAcc()
      s.turns += row.turns ?? 0
      s.failedTurns += row.failed ?? 0
      s.recoveredTurns += row.recovered ?? 0
      acc.set(model, s)
    }
  }

  let input = 0
  let output = 0
  let reasoning = 0
  let calls = 0
  let failed = 0
  let ttftMs = 0
  let ttftSamples = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const s of acc.values()) {
    input += s.input
    output += s.output
    reasoning += s.reasoning
    calls += s.calls
    failed += s.failed
    ttftMs += s.ttftMs
    ttftSamples += s.ttftSamples
    decodeMs += s.decodeMs
    decodeTokens += s.decodeTokens
  }
  const avgTtftMs = ttftSamples > 0 ? Math.round(ttftMs / ttftSamples) : null
  const tps = decodeMs >= MIN_DECODE_MS ? Math.round(decodeTokens / (decodeMs / 1000)) : null

  const available = period === 'all' ? true : turnDataAvailable(stats, bounds)

  const metrics = period === 'all'
    ? { ...lifetimeMetrics(stats, acc, { turns, failedTurns, recoveredTurns, calls, failed }), avgTtftMs, tps }
    : {
        turns: available ? turns : null,
        failedTurns: available ? failedTurns : null,
        recoveredTurns: available ? recoveredTurns : null,
        requests: calls,
        failedRequests: failed,
        input,
        output,
        reasoning,
        avgTtftMs,
        tps,
      }

  // 日/周/月档只列周期内有活动的模型；all 档不带 models（前端复用顶层 models）。
  const models = period === 'all'
    ? undefined
    : [...acc.entries()]
        .filter(([, s]) => s.turns > 0 || s.calls > 0)
        .map(([model, s]) => toModelRow(model, s, catalog))

  const chart = buildChart(byDay, period, bounds, now, metrics.input + metrics.output)

  const migration = period === 'all' ? '' : migrationNote(stats, bounds)
  const retention = period === 'all' ? retentionNote(bounds) : ''

  return {
    bounds: migration ? { ...bounds, note: migration } : bounds,
    metrics,
    ...(models ? { models } : {}),
    chart,
    turnsAvailable: available,
    ...(retention ? { note: retention } : {}),
  }
}

/**
 * 四档一次算完。
 * @returns {{day: object, week: object, month: object, all: object}}
 */
export function buildUsagePeriods(stats, catalog, now = Date.now()) {
  const periods = {}
  for (const period of USAGE_PERIODS) {
    periods[period] = aggregatePeriod(stats, period, catalog, now)
  }
  return periods
}
