/**
 * 四档时间范围聚合（usage-periods.js）的纯函数契约与数值护栏。
 *
 * Run: node scripts/usage-period-test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  USAGE_PERIODS,
  USAGE_PERIOD_LABELS,
  localDayKey,
  periodBounds,
  aggregatePeriod,
  buildUsagePeriods,
  toModelRow,
} from '../src/core/usage-periods.js'
import { buildStats } from '../src/core/stats.js'

let failures = 0
const check = (name, run) => {
  try { run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`) }
}

const catalog = [{ id: 'mimo-v2.6-flash-free', name: 'Mimo' }]
const m = 'mimo-v2.6-flash-free'

// ── 1. periodBounds：今日 / 周一 / 月末 / 跨年 / all ──────────────────────────
check('day bounds anchor on the local calendar day', () => {
  const bounds = periodBounds('day', new Date(2026, 9, 16, 15))
  assert.equal(bounds.period, 'day')
  assert.equal(bounds.start, '2026-10-16')
  assert.equal(bounds.end, '2026-10-16')
  assert.deepEqual(bounds.days, ['2026-10-16'])
  assert.equal(bounds.ongoing, true)
  assert.match(bounds.label, /今日 · 2026-10-16/)
})
check('week starts on Monday and spans seven days', () => {
  const bounds = periodBounds('week', new Date(2026, 9, 16, 15))
  assert.equal(bounds.start, '2026-10-12')
  assert.equal(bounds.end, '2026-10-18')
  assert.equal(bounds.days.length, 7)
  assert.equal(bounds.days[0], '2026-10-12')
  assert.equal(bounds.days[6], '2026-10-18')
  assert.equal(new Date(`${bounds.start}T12:00:00`).getDay(), 1, '周起点必须是周一')
})
check('month bounds cover the first through the last day', () => {
  const bounds = periodBounds('month', new Date(2026, 9, 16, 15))
  assert.equal(bounds.start, '2026-10-01')
  assert.equal(bounds.end, '2026-10-31')
  assert.equal(bounds.days.length, 31)
})
check('a week spanning the new year does not use ISO week numbering', () => {
  const bounds = periodBounds('week', new Date(2026, 0, 1))
  assert.equal(bounds.start, '2025-12-29')
  assert.equal(bounds.end, '2026-01-04')
  assert.deepEqual(bounds.days, ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'])
})
check('all bounds use the earliest retained day bucket', () => {
  const bounds = periodBounds('all', new Date(2026, 9, 16), { days: { '2026-06-19': {}, '2026-10-16': {} } })
  assert.equal(bounds.start, '2026-06-19')
  assert.equal(bounds.end, '2026-10-16')
  assert.equal(bounds.ongoing, false)
  assert.equal(bounds.label, '累计 · 自 2026-06-19 起')
})
check('all bounds omit the suffix when there are no day buckets', () => {
  const bounds = periodBounds('all', new Date(2026, 9, 16), {})
  assert.equal(bounds.start, '')
  assert.equal(bounds.label, '累计')
})

// ── 2. 跨夏令时：日集合连续且不重复（子进程 TZ 隔离） ───────────────────────
for (const timezone of ['Asia/Shanghai', 'America/New_York']) {
  check(`week days are continuous across DST (${timezone})`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { periodBounds } from './src/core/usage-periods.js'
      const bounds = periodBounds('week', new Date(2026, 2, 9, 1))
      assert.equal(bounds.days.length, 7)
      assert.equal(new Set(bounds.days).size, 7, 'week 日集合不得重复')
      const start = new Date(bounds.days[0] + 'T12:00:00')
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(start); d.setDate(d.getDate() + i)
        const y = d.getFullYear()
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const dd = String(d.getDate()).padStart(2, '0')
        assert.equal(bounds.days[i], \`\${y}-\${mm}-\${dd}\`, 'week 日集合必须逐日连续')
      }
    `], { cwd: new URL('../', import.meta.url), env: { ...process.env, TZ: timezone }, encoding: 'utf8' })
    assert.equal(result.status, 0, `${timezone}: ${result.stderr}`)
  })
}

// ── 3. 加权规则：周档均值 ≠ 各日均值的算术平均（禁止二次平均） ──────────────
check('week avgTtftMs weights by sample count, not by day', () => {
  const days = {}
  for (let i = 0; i < 7; i += 1) {
    const key = localDayKey(new Date(2026, 9, 12 + i, 12))
    days[key] = {
      total: 1,
      models: { [m]: { input: 1, output: 1, reasoning: 0, cacheRead: 0, calls: 1, failed: 0,
        ttftMs: i === 0 ? 1000 : 100000, ttftSamples: i === 0 ? 100 : 1, decodeMs: 0, decodeTokens: 0 } },
    }
  }
  const week = aggregatePeriod({ days }, 'week', catalog, new Date(2026, 9, 14, 12))
  assert.equal(week.metrics.avgTtftMs, Math.round(601000 / 106))
  assert.notEqual(week.metrics.avgTtftMs, Math.round(600010 / 7))
})

// ── 4. tps 门槛按周期合并后判断 ──────────────────────────────────────────────
check('tps threshold is judged on the merged period, not per day', () => {
  const days = {}
  for (let i = 0; i < 7; i += 1) {
    const key = localDayKey(new Date(2026, 9, 12 + i, 12))
    days[key] = { total: 1, models: { [m]: { input: 1, output: 1, reasoning: 0, cacheRead: 0, calls: 1,
      failed: 0, ttftMs: 0, ttftSamples: 0, decodeMs: 40, decodeTokens: 10 } } }
  }
  const week = aggregatePeriod({ days }, 'week', catalog, new Date(2026, 9, 14, 12))
  assert.equal(week.metrics.tps, 250)
  const singleDay = aggregatePeriod({ days }, 'day', catalog, new Date(2026, 9, 14, 12))
  assert.equal(singleDay.metrics.tps, null)
})

// ── 5. 全部档：指标取 lifetime，chart 按月聚合 ────────────────────────────────
check('all period reads lifetime metrics and month-granularity chart', () => {
  const raw = {
    requests: 50,
    failedRequests: 3,
    logical: { turns: 40, failed: 2, recovered: 4, estimated: true, models: { [m]: { turns: 40, failed: 2, recovered: 4 } } },
    models: { [m]: { input: 9000, output: 1000, reasoning: 10, cacheRead: 5, calls: 50, failed: 3 } },
    days: {
      '2026-08-01': { total: 100, models: { [m]: { input: 90, output: 10, reasoning: 0, cacheRead: 0, calls: 1, failed: 0, ttftMs: 100, ttftSamples: 1, decodeMs: 0, decodeTokens: 0 } } },
      '2026-09-01': { total: 200, models: { [m]: { input: 180, output: 20, reasoning: 0, cacheRead: 0, calls: 1, failed: 0, ttftMs: 200, ttftSamples: 1, decodeMs: 0, decodeTokens: 0 } } },
    },
  }
  const out = buildStats(raw, catalog)
  const all = out.periods.all
  assert.equal(all.metrics.turns, out.turns)
  assert.equal(all.metrics.requests, out.requests)
  assert.equal(all.metrics.input, out.grand.input)
  assert.equal(all.metrics.output, out.grand.output)
  assert.equal(all.metrics.reasoning, out.grand.reasoning)
  assert.equal(all.metrics.failedRequests, out.requestFailures)
  assert.equal(all.chart.granularity, 'month')
  assert.ok(all.chart.bars.length <= 5)
  assert.equal(all.models, undefined, 'all 档不带 models，前端复用顶层 models')
  assert.match(all.note, /120 个自然日/)
  assert.match(all.chart.note, /120 个自然日/)
})

// ── 6. logicalDailySince 判定 ────────────────────────────────────────────────
check('periods entirely before the migration day hide turn columns', () => {
  const stats = { logicalDailySince: '2026-10-15', days: {} }
  const day = aggregatePeriod(stats, 'day', catalog, new Date(2026, 9, 14, 12))
  assert.equal(day.turnsAvailable, false)
  assert.equal(day.metrics.turns, null)
  assert.equal(day.metrics.failedTurns, null)
  assert.equal(day.metrics.recoveredTurns, null)
})
check('a period crossing the migration day is available and annotated', () => {
  const stats = { logicalDailySince: '2026-10-15', days: {} }
  const week = aggregatePeriod(stats, 'week', catalog, new Date(2026, 9, 16, 12))
  assert.equal(week.turnsAvailable, true)
  assert.match(week.bounds.note, /2026-10-15/)
})
check('a fresh install has turn data available from the start', () => {
  const week = aggregatePeriod({ logicalDailySince: '', days: {} }, 'week', catalog, new Date(2026, 9, 16, 12))
  assert.equal(week.turnsAvailable, true)
  assert.equal(week.bounds.note, undefined)
})

// ── 7. 纯函数契约：调用前后入参深比较不变 ─────────────────────────────────────
check('buildUsagePeriods does not mutate its inputs', () => {
  const stats = {
    days: { '2026-10-14': { total: 100, models: { [m]: { input: 100, output: 0, reasoning: 0, cacheRead: 0, calls: 1, failed: 0, ttftMs: 10, ttftSamples: 1, decodeMs: 300, decodeTokens: 5 } }, turns: 1, failedTurns: 0, recoveredTurns: 0, modelsTurns: { [m]: { turns: 1, failed: 0, recovered: 0 } } } },
    models: { [m]: { input: 100, output: 0, reasoning: 0, cacheRead: 0, calls: 1, failed: 0 } },
    logical: { turns: 1, failed: 0, recovered: 0, models: { [m]: { turns: 1, failed: 0, recovered: 0 } } },
    logicalDailySince: '',
  }
  const before = structuredClone(stats)
  buildUsagePeriods(stats, catalog, new Date(2026, 9, 14, 12))
  assert.deepEqual(stats, before)
})

// ── 8. totals 依赖陷阱护栏：lifetime models 置空后 grand 仍等于日桶累加 ──────
check('grand still falls back to day buckets after lifetime models are emptied', () => {
  const days = {
    '2026-10-14': { total: 150, models: { [m]: { input: 100, output: 50, reasoning: 0, cacheRead: 0, calls: 1, failed: 0, ttftMs: 10, ttftSamples: 1, decodeMs: 0, decodeTokens: 0 } } },
    '2026-10-15': { total: 60, models: { [m]: { input: 40, output: 20, reasoning: 0, cacheRead: 0, calls: 1, failed: 0, ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0 } } },
  }
  const out = buildStats({ days, models: {} }, catalog)
  assert.equal(out.grand.input, 140)
  assert.equal(out.grand.output, 70)
  assert.equal(out.models[0].input, 140)
  assert.ok(out.days.length >= 1)
  assert.equal('models' in out.days[0], false, '对外 days 必须精简为 {day,total}')
})

// ── 9. 模型行同构：all 顶层 models 与 periods.week.models 键集合一致 ────────
check('top-level and period model rows share the same toModelRow shape', () => {
  // 日期必须落在「本周」窗口内，buildStats 用 Date.now() 算周期边界。
  // 写死日期会随真实时间推移滑出窗口，让 periods.week.models 变空 —— 那是
  // 用例过期，不是行结构不一致。
  const today = localDayKey(new Date())
  const raw = {
    requests: 2,
    failedRequests: 0,
    logical: { turns: 2, failed: 0, recovered: 1, models: { [m]: { turns: 2, failed: 0, recovered: 1 } } },
    models: { [m]: { input: 100, output: 50, reasoning: 0, cacheRead: 0, calls: 2, failed: 0 } },
    days: { [today]: { total: 150, models: { [m]: { input: 100, output: 50, reasoning: 0, cacheRead: 0, calls: 1, failed: 0, ttftMs: 10, ttftSamples: 1, decodeMs: 300, decodeTokens: 5 } }, turns: 2, failedTurns: 0, recoveredTurns: 1, modelsTurns: { [m]: { turns: 2, failed: 0, recovered: 1 } } } },
  }
  const out = buildStats(raw, catalog)
  assert.ok(out.periods.week.models.length > 0, '本周窗口应包含今天的数据')
  const topKeys = Object.keys(out.models[0]).sort()
  const weekKeys = Object.keys(out.periods.week.models[0]).sort()
  assert.deepEqual(topKeys, weekKeys)
  for (const forbidden of ['ttftMs', 'ttftSamples', 'decodeMs', 'decodeTokens']) {
    assert.ok(!topKeys.includes(forbidden), `顶层模型行不得透传 ${forbidden}`)
    assert.ok(!weekKeys.includes(forbidden), `周期模型行不得透传 ${forbidden}`)
  }
  assert.ok(out.periods.week.models[0].turns > 0)
})

// ── 10. 基本契约：枚举顺序与文案、toModelRow 派生值 ─────────────────────────
check('period enum order and labels are stable', () => {
  assert.deepEqual(USAGE_PERIODS, ['day', 'week', 'month', 'all'])
  assert.deepEqual(USAGE_PERIOD_LABELS, { day: '每日', week: '每周', month: '每月', all: '全部' })
})
check('toModelRow derives name, avgTtftMs and gated tps once', () => {
  const row = toModelRow(m, {
    input: 10, output: 5, reasoning: 0, cacheRead: 0, calls: 2, failed: 1,
    ttftMs: 300, ttftSamples: 3, decodeMs: 300, decodeTokens: 9, turns: 2, failedTurns: 0, recoveredTurns: 1,
  }, catalog)
  assert.equal(row.name, 'Mimo')
  assert.equal(row.avgTtftMs, 100)
  assert.equal(row.tps, 30)
  assert.equal(row.cacheRead, 0)
})

console.log(failures === 0 ? '\nusage-period: 四档聚合契约全部通过' : `\nusage-period: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
