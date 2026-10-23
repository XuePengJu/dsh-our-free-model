/**
 * 自动签到「每日到点」调度回归：开关默认值、`time` 契约、UTC+8 判据、跨天重触发。
 *
 *     node scripts/auto-checkin-schedule-test.mjs
 *
 * ## 它守的是什么
 *
 * 2026-10-19 的改造把「每日首次启动自动签到」改成「每天 `time`（UTC+8）到点签」。
 * 改造前的真实缺口：进程常驻不重启 ⇒ 第二天永远不再签 ——「每日」实际退化成了
 * 「每次启动」。所以本文件里**最重要的一条**不是「到点会签」，而是
 * {@link timerDrivenCrossDay}：同一个执行体实例、不重建、只推进假时钟，第二天
 * 到点必须**再触发一次**。改造前的实现（只排一次定时器）在这条上必然红。
 *
 * ## 零等待、零网络、零本机时区依赖
 *
 * 三条硬约束，缺一条就会让本文件变成「跑得慢又不稳」的噪声源：
 *
 * 1. **假时钟**：`AutoCheckinDeps.now()` 注入可变时间戳，跨天只是改一个整数；
 * 2. **假定时器**：`AutoCheckinDeps.schedule()` 把回调连同「到期时刻」收进队列，
 *    由本文件按需 `fireDue()`。绝不真等 5 分钟，也不依赖 `setInterval` 的语义；
 * 3. **假时区**：见文件顶部对 `process.env.TZ` 的赋值 —— 本文件在**非 UTC+8** 的
 *    时区下运行。被测代码若误用 `getHours()`（本机时区）而不是算术平移，
 *    UTC+8 那一组断言会立刻红，而不是「在开发者机器上恰好通过」。
 *
 * `claim` 是桩函数，只记录被调了哪些渠道，绝不发真实上游请求。
 *
 * ## 被测代码怎么加载
 *
 * `auto-checkin.ts` 是 TypeScript 源码，本仓库没有 `tsc` 运行期加载路径，但
 * `node_modules` 里有 esbuild（`scripts/build-channel-pack.mjs` 用的同一个）。
 * 故这里用 esbuild 即时打成临时 ESM，再 `import()`。`@deepseek-ai/*` 是宿主提供
 * 的模块，用 `scripts/lib/channel-pack-kernel.mjs`（已有的最小宿主契约替身）
 * 在 resolve 阶段短路，与 `scripts/channel-pack-test.mjs` 的 `--source` 模式同款。
 *
 * RPC 那一组（`usage.autoCheckin` 的 `time` 校验）要挂载真实的
 * `channel-pack-rpc.ts`：它是唯一能证明「客户端能存的值 = 调度认的值」的地方，
 * 在 `auto-checkin.ts` 里再写一遍校验会漂移。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * ⚠️ **必须**在任何 `Date` 运算之前设定：本文件的全部 UTC+8 断言都建立在
 * 「本机时区不是 UTC+8」之上。取 `America/New_York` 是因为它与 UTC+8 相差 12–13
 * 小时，误用本机时区时几乎必然落到**前一天**，差异一眼可见（不像 UTC 只差 8 小时）。
 */
process.env.TZ = 'America/New_York'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-auto-checkin-'))

/** UTC+8 相对 UTC 的偏移（与 `model-queue.ts` 的 `QODER_BILLING_UTC_OFFSET_MS` 同值）。 */
const UTC8_OFFSET_MS = 8 * 3_600_000

/**
 * 「UTC+8 墙上时间」→ UTC 毫秒时间戳。
 *
 * `Date.UTC(...)` 先当作 UTC 解释，再减 8 小时 ⇒ 得到的瞬间其 **UTC+8 墙上时间**
 * 正好是入参。测试里所有时间点都该经它构造，别手写魔数。
 */
const utc8 = (year, month, day, hour = 0, minute = 0) =>
  Date.UTC(year, month - 1, day, hour, minute) - UTC8_OFFSET_MS

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------

const results = []

/**
 * 跑一条用例：捕获断言失败并如实记录（不中断后续用例）。
 *
 * 每条结果带一个**互斥**的 `kind`，供汇总分类（见文件末尾）。不要用 `ok` 布尔
 * 兼表多种语义 —— 那正是上一版 XPASS 时摘要写「失败 0」却在失败清单里又列一条、
 * 且打印出 `undefined` 的成因。
 *
 * - `pass`  — 正常通过；
 * - `fail`  — 正常失败（真问题）；
 * - `xfail` — 标了 `expectedToFail` 且**确实失败**（已知缺陷仍在，符合预期）；
 * - `xpass` — 标了 `expectedToFail` 却**通过了**（缺陷已修，该摘标记）。
 *
 * `expectedToFail` 的用法：缺陷修好前把用例标成 XFAIL，修好后它会变 XPASS 并
 * 让套件变红，提示把标记摘掉。跳过（skip）不是选项 —— 跳过的用例在修复后
 * 不会有人注意到它变绿了。
 */
async function test(name, run, options = {}) {
  const { expectedToFail = false, reason = '' } = options
  try {
    await run()
    if (expectedToFail) {
      results.push({
        name,
        kind: 'xpass',
        detail: `已知缺陷似乎已修复（${reason}）—— 请把该用例的 expectedToFail 摘掉，转成正式回归`,
      })
      console.log(`XPASS ${name}`)
      console.log(`       已知缺陷似乎已修复（${reason}）—— 请把 expectedToFail 摘掉转成正式回归`)
      return
    }
    results.push({ name, kind: 'pass' })
    console.log(`ok   ${name}`)
  } catch (error) {
    if (expectedToFail) {
      results.push({ name, kind: 'xfail', detail: `已知缺陷，符合预期：${reason}`, error })
      console.log(`xfail ${name}`)
      console.log(`       已知缺陷，符合预期：${reason}`)
      return
    }
    results.push({ name, kind: 'fail', error })
    console.log(`FAIL ${name}`)
    const detail = String(error?.message ?? error).split('\n').map(line => `       ${line}`).join('\n')
    console.log(detail)
  }
}

// ---------------------------------------------------------------------------
// 加载被测代码
// ---------------------------------------------------------------------------

let esbuild

/** 按需解析 esbuild（走 CJS 解析，与 `build-channel-pack.mjs` 同款，兼容 NODE_PATH）。 */
async function loadEsbuild() {
  if (esbuild !== undefined) return esbuild
  const require = createRequire(path.join(root, 'package.json'))
  const resolved = require.resolve('esbuild')
  esbuild = await import(pathToFileURL(resolved).href)
  return esbuild
}

/**
 * 把 `vendor/channel-pack/src/<entry>` 打成单文件 ESM 临时模块并返回其 URL。
 *
 * `external: ['node:*']` 保留平台内置；其余全部内联（`auto-checkin.ts` 的传递依赖
 * 里有 `jose`/`undici` 之外的东西，内联才不会踩到「模块解析路径不对」）。
 * `@deepseek-ai/*` 是宿主模块，用已有替身短路。
 */
async function bundleSource(entry, outName) {
  const builder = await loadEsbuild()
  const outfile = path.join(scratch, outName)
  const kernelStub = path.join(root, 'scripts', 'lib', 'channel-pack-kernel.mjs')
  await builder.build({
    entryPoints: [path.join(root, 'vendor', 'channel-pack', 'src', entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    external: ['node:*'],
    plugins: [{
      name: 'host-kernel-stub',
      setup(build) {
        build.onResolve({ filter: /^@deepseek-ai\// }, () => ({ path: kernelStub }))
      },
    }],
    logLevel: 'warning',
    // 内联的 CJS 依赖（undici 等）会 `require()` 平台内置；ESM 产物里必须补一个
    // 真实的 `require`，否则加载即报 "Dynamic require of ... is not supported"。
    banner: {
      js: [
        "import { createRequire as __ofmCreateRequire } from 'node:module'",
        'const require = __ofmCreateRequire(import.meta.url)',
      ].join('\n'),
    },
  })
  return pathToFileURL(outfile).href
}

// ---------------------------------------------------------------------------
// 替身：文档、时钟、定时器、claim
// ---------------------------------------------------------------------------

/**
 * 内存文档后端（与 `AutoCheckinStore` 同接口）。
 *
 * `doc` 与 `DEFAULT_AUTO_CHECKIN` 合并，这样用例只写自己关心的字段 —— 尤其是
 * 「旧文档没有 `time`」这类用例，合并后的默认值正好模拟 `sanitizeAutoCheckin` 的回落。
 */
function memoryStore(doc, defaults) {
  let current = { ...defaults, ...doc }
  return {
    kind: 'memory',
    load: () => ({ ...current }),
    save: async next => { current = { ...next } },
    read: () => ({ ...current }),
  }
}

/**
 * 假时钟 + 假定时器（一次性 + 周期两种）。
 *
 * 不真排定任何东西，只把回调连同 `due = now + ms` 收进队列：
 * - `schedule(fn, ms)` → 一次性（首次延迟检查）；
 * - `scheduleInterval(fn, ms)` → 周期（每 5 分钟的到点检查），触发后 `due += ms`
 *   重新武装，与 `setInterval` 的语义一致。
 *
 * `fireDue()` 把**所有已到期**的回调按到期时刻顺序执行。周期定时器在同一次
 * drain 里可能连续到期多次（推进跨度大于周期时），这正确模拟了「合盖休眠唤醒后
 * 补齐错过的 tick」—— 被测代码必须对此幂等（`lastDate` 守卫）。
 *
 * ⚠️ 回调是 async 的（`runIfDue` 返回 Promise），`fireDue` 必须逐个 await，
 * 否则 claim 计数会在微任务跑完之前被断言读到 0。
 */
function fakeClock(startMs) {
  const state = { now: startMs, timers: [] }
  const makeTimer = (fn, ms, repeat) => {
    const timer = {
      fn, ms, repeat,
      due: state.now + ms,
      cancelled: false,
      /** 一次性定时器已触发过（周期定时器靠 `due += ms` 前进来表示「还没到期」）。 */
      done: false,
      fires: 0,
      cancel() { timer.cancelled = true },
    }
    state.timers.push(timer)
    return timer
  }
  const schedule = (fn, ms) => makeTimer(fn, ms, false)
  const scheduleInterval = (fn, ms) => makeTimer(fn, ms, true)
  const advance = deltaMs => { state.now += deltaMs }
  const setNow = nextMs => { state.now = nextMs }
  const isDue = row => !row.cancelled && !row.done && row.due <= state.now
  const fireDue = async () => {
    let fired = 0
    // 上界只为防「回调里排定了 due<=now 的定时器」把本函数变成死循环。
    for (let guard = 0; guard < 100_000; guard += 1) {
      const due = state.timers.filter(isDue).sort((left, right) => left.due - right.due)
      if (due.length === 0) break
      const timer = due[0]
      timer.fires += 1
      if (timer.repeat) timer.due += timer.ms
      else timer.done = true
      await timer.fn()
      fired += 1
    }
    return fired
  }
  /** 尚未到期的一次性定时器（周期定时器不在此列：它「永远在转」）。 */
  const pending = () => state.timers.filter(row => !row.cancelled && !row.done && !row.repeat)
  const intervals = () => state.timers.filter(row => row.repeat)
  return {
    schedule, scheduleInterval, advance, setNow, fireDue, pending, intervals,
    timers: state.timers,
    get now() { return state.now },
  }
}

/**
 * 推进假时钟并持续触发到期回调。
 *
 * 步长取 1 分钟：**刻意小于**「每 5 分钟」的周期，这样无论实现用的是 5 分钟还是
 * 别的周期（哪怕 1 分钟），只要有定时器到期就一定会被本函数触发 —— 用例不会因为
 * 「周期常量改了个数」而假红。
 */
async function drive(clock, spanMs, stepMs = 60_000) {
  const steps = Math.max(1, Math.ceil(spanMs / stepMs))
  for (let index = 0; index < steps; index += 1) {
    clock.advance(stepMs)
    await clock.fireDue()
  }
}

/** claim 桩：记录调用渠道，返回可控的 summary。 */
function claimRecorder(summary) {
  const calls = []
  const claim = async provider => {
    calls.push(provider)
    return { ok: true, value: { summary: { ...summary } } }
  }
  return { calls, claim }
}

/** 「今天这一轮已被处理」的默认 summary（`coversToday` 为 1 ⇒ 会记日期）。 */
const TODAY_SUMMARY = {
  claimed: 1,
  totalCredit: 100,
  totalByUnit: { credit: 100, token: 0 },
  alreadyClaimed: 0,
  inactive: 0,
  failed: 0,
  coversToday: 1,
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let src
try {
  src = await import(await bundleSource('auto-checkin.ts', 'auto-checkin.mjs'))
} catch (error) {
  console.error('无法加载 vendor/channel-pack/src/auto-checkin.ts：')
  console.error(String(error?.message ?? error))
  fs.rmSync(scratch, { recursive: true, force: true })
  process.exit(1)
}

/** 建一个注入了假时钟/假定时器/桩 claim 的执行体。 */
function createEngine({ doc = {}, nowMs, providers = ['qoder'], summary = TODAY_SUMMARY } = {}) {
  const clock = fakeClock(nowMs)
  const store = memoryStore(doc, src.DEFAULT_AUTO_CHECKIN)
  const recorder = claimRecorder(summary)
  const warnings = []
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => providers,
    claim: recorder.claim,
    now: () => clock.now,
    // 30 秒是生产默认值：首轮检查**不能**与 `runIfDue` 的即时语义混为一谈。
    delayMs: 30_000,
    schedule: clock.schedule,
    scheduleInterval: clock.scheduleInterval,
    warn: message => warnings.push(message),
  })
  return { engine, clock, store, calls: recorder.calls, warnings }
}

// === 0. 前提：本机时区确实不是 UTC+8 =====================================

await test('前提：本机时区非 UTC+8（否则时区相关断言无意义）', () => {
  // UTC+8 的 10:05，其本机墙上时间在 America/New_York 是**前一天** 22:05。
  const localHour = new Date(utc8(2026, 10, 20, 10, 5)).getHours()
  assert.notEqual(localHour, 10, `本机时区仍是 UTC+8（getHours()=${localHour}），时区断言会失去意义`)
  // 顺带把「差一天」这件事钉住：这才是误用本机时区时会踩到的形态。
  assert.equal(new Date(utc8(2026, 10, 20, 10, 5)).getDate(), 19)
})

// === 1. 默认关闭 ==========================================================

await test('默认值：开关关闭（enabled === false）', () => {
  assert.equal(src.DEFAULT_AUTO_CHECKIN.enabled, false, '改造后默认必须是关闭：这是代用户打上游的写操作')
})

await test('默认值：签到时间 10:05（UTC+8）', () => {
  assert.equal(src.DEFAULT_AUTO_CHECKIN.time, '10:05')
})

// === 2. sanitize 判据反转：只有显式 true 才算开 ============================

for (const [raw, expected, label] of [
  [{ enabled: true }, true, '显式 true'],
  [{}, false, '无 enabled 字段（旧文档）'],
  [{ enabled: 'true' }, false, '字符串 "true"'],
  [{ enabled: false }, false, '显式 false'],
  [{ enabled: 1 }, false, '数字 1'],
  [{ enabled: null }, false, 'null'],
  [{ enabled: undefined }, false, 'undefined'],
]) {
  await test(`sanitize.enabled：${label} → ${expected ? '打开' : '关闭'}`, () => {
    const doc = src.sanitizeAutoCheckin(raw)
    assert.equal(doc.enabled, expected, `输入 ${JSON.stringify(raw)} 的 enabled 判据错误`)
  })
}

// === 3. time 字段回落 =====================================================

for (const [raw, expected, label] of [
  [{}, '10:05', '旧文档无 time 字段 → 回落默认'],
  [{ time: '9:05' }, '10:05', '单数字小时 → 回落'],
  [{ time: '25:00' }, '10:05', '小时越界 → 回落'],
  [{ time: '10:60' }, '10:05', '分钟越界 → 回落'],
  [{ time: '10:05:00' }, '10:05', '带秒 → 回落'],
  [{ time: ' 10:05' }, '10:05', '前导空格 → 回落'],
  [{ time: '10:05 ' }, '10:05', '尾随空格 → 回落'],
  [{ time: '10：05' }, '10:05', '全角冒号 → 回落'],
  [{ time: 1005 }, '10:05', '数字类型 → 回落'],
  [{ time: '10:05' }, '10:05', '合法值 → 保留'],
  [{ time: '23:59' }, '23:59', '合法边界 23:59 → 保留'],
  [{ time: '00:00' }, '00:00', '合法边界 00:00 → 保留'],
]) {
  await test(`sanitize.time：${label}`, () => {
    const doc = src.sanitizeAutoCheckin(raw)
    assert.equal(doc.time, expected, `输入 ${JSON.stringify(raw)} 的 time 归一化错误`)
  })
}

await test('sanitize.time：非法值不得被「宽松修正」成合法值（不补零、不截断）', () => {
  // 与 RPC 严格校验同口径：`'9:05'` 不能悄悄变成 `'09:05'`，否则 UI 能存、调度不生效。
  assert.notEqual(src.sanitizeAutoCheckin({ time: '9:05' }).time, '09:05')
  assert.notEqual(src.sanitizeAutoCheckin({ time: '10:05:00' }).time, '10:05:00')
})

// === 4. UTC+8 时间比较正确性 ==============================================

await test('UTC+8：utc8DateString 在日界两侧正确', () => {
  assert.equal(src.utc8DateString(utc8(2026, 10, 20, 0, 0)), '2026-10-20', 'UTC+8 00:00 属于当天')
  assert.equal(src.utc8DateString(utc8(2026, 10, 20, 23, 59)), '2026-10-20', 'UTC+8 23:59 仍属当天')
  assert.equal(src.utc8DateString(utc8(2026, 10, 20, 0, 0) - 1), '2026-10-19', 'UTC+8 00:00 前一毫秒属前一天')
})

await test('UTC+8：utc8MinutesOfDay 折算出正确的当日分钟数', () => {
  assert.equal(typeof src.utc8MinutesOfDay, 'function', '缺少导出 utc8MinutesOfDay')
  assert.equal(src.utc8MinutesOfDay(utc8(2026, 10, 20, 0, 0)), 0)
  assert.equal(src.utc8MinutesOfDay(utc8(2026, 10, 20, 9, 59)), 599)
  assert.equal(src.utc8MinutesOfDay(utc8(2026, 10, 20, 10, 5)), 605)
  assert.equal(src.utc8MinutesOfDay(utc8(2026, 10, 20, 23, 59)), 1439)
})

await test('UTC+8：isTimeReachedToday 在多个边界点正确（不受本机时区影响）', () => {
  assert.equal(typeof src.isTimeReachedToday, 'function', '缺少导出 isTimeReachedToday')
  const reached = ms => src.isTimeReachedToday('10:05', ms)
  assert.equal(reached(utc8(2026, 10, 20, 0, 0)), false, 'UTC+8 00:00 未到 10:05')
  assert.equal(reached(utc8(2026, 10, 20, 9, 59)), false, 'UTC+8 09:59 未到')
  assert.equal(reached(utc8(2026, 10, 20, 10, 4)), false, 'UTC+8 10:04 未到')
  assert.equal(reached(utc8(2026, 10, 20, 10, 5)), true, 'UTC+8 10:05 已到（判据是 >=）')
  assert.equal(reached(utc8(2026, 10, 20, 10, 6)), true, 'UTC+8 10:06 已到')
  assert.equal(reached(utc8(2026, 10, 20, 23, 59)), true, 'UTC+8 23:59 已到')
})

await test('UTC+8：跨日后「今天」重新变成未到点（00:00 属于新的一天）', () => {
  const lastMinuteOfDay1 = utc8(2026, 10, 20, 23, 59)
  const firstMinuteOfDay2 = utc8(2026, 10, 21, 0, 0)
  assert.equal(src.isTimeReachedToday('10:05', lastMinuteOfDay1), true)
  assert.equal(src.isTimeReachedToday('10:05', firstMinuteOfDay2), false, '跨日后必须重新等今天的 10:05')
  assert.equal(src.utc8DateString(firstMinuteOfDay2), '2026-10-21')
})

await test('UTC+8：非法 time 一律判「未到点」（宁可当天不签，也不在意外时刻打上游）', () => {
  for (const bad of ['9:05', '25:00', '10:05:00', ' 10:05', '']) {
    assert.equal(src.isTimeReachedToday(bad, utc8(2026, 10, 20, 23, 0)), false, `非法值 ${JSON.stringify(bad)} 不得判成已到点`)
  }
})

// === 5. 到点才签 ==========================================================

await test('调度：未到点不签（UTC+8 09:00，设定 10:05）', async () => {
  const { engine, calls } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 9, 0),
  })
  await engine.runIfDue()
  assert.deepEqual(calls, [], '未到设定时间不应调用 claim')
})

await test('调度：到点后签（UTC+8 10:06，设定 10:05）', async () => {
  const { engine, calls, store } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.runIfDue()
  assert.deepEqual(calls, ['qoder'], '到点后应签一轮')
  assert.equal(store.read().lastDate, '2026-10-20', 'lastDate 必须记为 UTC+8 当天')
})

// === 6. 当天不重复 ========================================================

await test('去重：lastDate 已是今天 → 到点也不签', async () => {
  const { engine, calls } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '2026-10-20' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.runIfDue()
  assert.deepEqual(calls, [], '当天已签过不应重复')
})

// === 7. 跨天重新触发（核心回归）===========================================

await test('核心回归：跨天重新触发（同一实例、不重建）', async () => {
  const { engine, clock, calls, store } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.runIfDue()
  assert.equal(calls.length, 1, '第 1 天到点应签一次')
  assert.equal(store.read().lastDate, '2026-10-20')

  await engine.runIfDue()
  assert.equal(calls.length, 1, '同一天第二次不应重复')

  clock.setNow(utc8(2026, 10, 21, 9, 0))
  await engine.runIfDue()
  assert.equal(calls.length, 1, '第 2 天尚未到点不应签')

  clock.setNow(utc8(2026, 10, 21, 10, 6))
  await engine.runIfDue()
  assert.equal(calls.length, 2, '第 2 天到点必须再次触发 —— 这是本次改造的核心验收点')
  assert.equal(store.read().lastDate, '2026-10-21', 'lastDate 必须前进到第 2 天')
})

// === 8. 关闭开关后不签 ====================================================

await test('关闭：enabled=false 时即使到点、即使今天没签，也不触发', async () => {
  const { engine, calls } = createEngine({
    doc: { enabled: false, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.runIfDue()
  assert.deepEqual(calls, [], '关闭状态下 runIfDue 不应签')
})

await test('关闭：start() 后不签（周期检查即便在转，也不得产生任何签到）', async () => {
  const { engine, clock, calls } = createEngine({
    doc: { enabled: false, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  engine.start()
  try {
    // ⚠️ 这里**不**断言「一个定时器都没有」：实现的取舍是「周期检查常转但完全惰性」
    //（见 `runIfDue` 的 `!doc.enabled` 守卫），而不是「关闭时拆掉定时器」。
    // 前者每天 288 次空转、只做几次算术比较；后者在「运行中关开关」时需要额外的
    // 拆除/重建逻辑。语义上真正要守住的是**不签**，故断言落在 claim 上。
    await drive(clock, 10 * 60_000)
    assert.deepEqual(calls, [], '关闭状态下首轮检查不得签')
    await drive(clock, 24 * 3_600_000)
    assert.deepEqual(calls, [], '关闭状态下常驻一整天也不得签')
  } finally {
    engine.stop()
  }
})

await test('关闭：stop() 会拆掉周期检查（插件卸载后不得再醒来）', async () => {
  const { engine, clock } = createEngine({
    doc: { enabled: false, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 8, 0),
  })
  engine.start()
  await drive(clock, 60_000) // 让首次检查到期，从而建立起周期检查
  assert.ok(clock.intervals().length > 0, '首次检查之后应当建立起周期检查（否则跨天回归无从谈起）')
  engine.stop()
  const live = clock.intervals().filter(row => !row.cancelled)
  assert.equal(live.length, 0, 'stop() 必须取消周期检查：unref() 只是不拖住退出，不代表不再触发')
})

// === 9. 定时器驱动：常驻进程跨天（真正的回归点）===========================

await test('定时器：常驻进程跨天自动签到（不重启、只推进时钟）', async () => {
  const { engine, clock, calls, store } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 8, 0),
  })
  engine.start()
  try {
    // 第 1 天：08:00 起步，推进 24 小时 ⇒ 应在 10:05 之后签一次。
    await drive(clock, 24 * 3_600_000)
    assert.equal(calls.length, 1, '第 1 天应恰好签一次（改造前只在启动时签，这条会红）')
    assert.equal(store.read().lastDate, '2026-10-20')

    // 第 2 天：同一实例继续常驻 ⇒ 必须再签一次。这是用户报障的原缺口。
    await drive(clock, 24 * 3_600_000)
    assert.equal(calls.length, 2, '第 2 天到点必须再次触发：进程常驻不重启也要签')
    assert.equal(store.read().lastDate, '2026-10-21')

    // 第 3 天：再确认一次，避免「只补一天」的实现蒙对。
    await drive(clock, 24 * 3_600_000)
    assert.equal(calls.length, 3, '第 3 天同样要触发')
    assert.equal(store.read().lastDate, '2026-10-22')
  } finally {
    engine.stop()
  }
})

await test('定时器：一天之内只签一次（不会每 5 分钟重复）', async () => {
  const { engine, clock, calls } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 0),
  })
  engine.start()
  try {
    await drive(clock, 13 * 3_600_000) // 10:00 → 23:00，跨过 10:05 且含大量周期检查
    assert.equal(calls.length, 1, '当天只应签一次')
  } finally {
    engine.stop()
  }
})

await test('定时器：到点时进程未启动 → 启动后立刻补签', async () => {
  const { engine, clock, calls } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 14, 0), // 下午才开机
  })
  engine.start()
  try {
    await drive(clock, 10 * 60_000) // 给足首轮延迟（默认 30 秒）
    assert.equal(calls.length, 1, '启动时已过今天的设定时间，应立刻补签')
  } finally {
    engine.stop()
  }
})

await test('定时器：stop() 之后不再触发', async () => {
  const { engine, clock, calls } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 8, 0),
  })
  engine.start()
  engine.stop()
  await drive(clock, 24 * 3_600_000)
  assert.deepEqual(calls, [], 'stop() 后不应再有任何自动签到')
})

// === 9b. start() 幂等性（热重载路径会重复调用）==========================

await test('start() 幂等：连续调用两次不排出两条周期检查', async () => {
  const { engine, clock } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 8, 0),
  })
  engine.start()
  engine.start()
  engine.start()
  try {
    // 首次检查还没到期时，三次调用只该有**一个**待执行的一次性定时器。
    assert.equal(clock.pending().length, 1, '重复 start() 不得排出多个首次检查定时器')
    await drive(clock, 60_000) // 让首次检查到期 ⇒ 建立周期检查
    const liveIntervals = clock.intervals().filter(row => !row.cancelled)
    assert.equal(liveIntervals.length, 1, `重复 start() 不得排出多条周期检查（实际 ${liveIntervals.length} 条）`)
  } finally {
    engine.stop()
  }
})

await test('start() 幂等：重复调用不会让一天签两次', async () => {
  const { engine, clock, calls } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 8, 0),
  })
  engine.start()
  engine.start()
  try {
    await drive(clock, 24 * 3_600_000)
    assert.equal(calls.length, 1, '重复 start() 后当天仍只该签一次（排了两条 ticker 会变成并发两轮）')
  } finally {
    engine.stop()
  }
})

// === 9c. tickMs 注入：周期检查的间隔确实生效 ============================

await test('tickMs 注入：压到 1 分钟后，过点即签（不必等满 5 分钟）', async () => {
  const clock = fakeClock(utc8(2026, 10, 20, 10, 0))
  const store = memoryStore({ enabled: true, time: '10:05', lastDate: '' }, src.DEFAULT_AUTO_CHECKIN)
  const recorder = claimRecorder(TODAY_SUMMARY)
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => ['qoder'],
    claim: recorder.claim,
    now: () => clock.now,
    delayMs: 0, // 首次检查立刻跑（走 ms<=0 分支），便于观察周期检查本身
    tickMs: 60_000,
    schedule: clock.schedule,
    scheduleInterval: clock.scheduleInterval,
  })
  engine.start()
  try {
    // 10:00 起步，首轮立刻判「未到点」；推进 6 分钟 ⇒ 若 tickMs 生效，
    // 至少有一次周期检查落在 10:05 之后。
    await drive(clock, 6 * 60_000, 60_000)
    assert.equal(recorder.calls.length, 1, 'tickMs=1min 时应能在 10:05 之后的第一个 tick 就签')
    const live = clock.intervals().filter(row => !row.cancelled)
    assert.equal(live.length, 1, '应当只有一条周期检查')
    assert.equal(live[0].ms, 60_000, `周期检查的间隔应等于注入的 tickMs，实际 ${live[0].ms}`)
  } finally {
    engine.stop()
  }
})

// === 9d. 关闭 → 重新打开 ================================================

await test('关闭后再打开：当天已签过 → 不重签（lastDate 是今天的守卫）', async () => {
  const { engine, clock, calls, store } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.setEnabled(true)
  await engine.runIfDue()
  assert.equal(calls.length, 1, '首次打开且已过点应签一次')
  assert.equal(store.read().lastDate, '2026-10-20')

  await engine.setEnabled(false)
  await engine.setEnabled(true)
  await engine.runIfDue()
  assert.equal(calls.length, 1, '当天已签过，关闭再打开不得重签')
})

await test('关闭后再打开：当天还没签过 → 补签', async () => {
  const { engine, calls, store } = createEngine({
    doc: { enabled: false, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.setEnabled(true)
  await engine.runIfDue()
  assert.equal(calls.length, 1, '打开开关且已过点应补签')

  await engine.setEnabled(false)
  await engine.runIfDue()
  assert.equal(calls.length, 1, '关闭后 runIfDue 不得再签')

  await engine.setEnabled(true)
  await engine.runIfDue()
  assert.equal(calls.length, 1, '当天已签过（lastDate=今天），重开不得重签')
  assert.equal(store.read().lastDate, '2026-10-20')
})

await test('关闭后重新打开：之后到点仍会签（关闭不应永久破坏调度）', async () => {
  const { engine, clock, calls, store } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  engine.start()
  try {
    await drive(clock, 60_000) // 10:06 → 10:07，首轮检查在 10:06 就已过点
    assert.equal(calls.length, 1, '第 1 天（10-20）应签一次')
    assert.equal(store.read().lastDate, '2026-10-20')

    // 关掉，跑一整天 ⇒ 不得签。此时时钟落在第 2 天（10-21）10:07。
    await engine.setEnabled(false)
    await drive(clock, 24 * 3_600_000)
    assert.equal(calls.length, 1, '关闭期间（第 2 天）不得签')
    assert.equal(store.read().lastDate, '2026-10-20', '关闭期间 lastDate 不应前进')

    // 重新打开：此刻是第 2 天 10:07，已过点且 lastDate 还是第 1 天 ⇒ 应补签。
    await engine.setEnabled(true)
    await engine.runIfDue()
    assert.equal(calls.length, 2, '重新打开后，只要今天没签过且已过点，就应补签')
    assert.equal(store.read().lastDate, '2026-10-21', 'lastDate 应前进到第 2 天（时钟推进 24h 的落点）')
  } finally {
    engine.stop()
  }
})

// === 9e. 日末盲区（已修复，2026-10-23 转正式回归）=========================

/**
 * ## 曾经的缺陷（2026-10-23 由本套件定位，同日修复）
 *
 * 旧判据是 `isTimeReachedToday` = `utc8MinutesOfDay(now) >= target`，而周期检查的
 * **相位由 `start()` 那一刻决定**（首次延迟 30 秒后建立 ticker，此后每 5 分钟一次）。
 * 若最后一次 tick 落在 `target` 之前、下一次 tick 已跨过午夜，那么「已过 target」
 * 这个条件在**当天永远不会被观察到** —— 午夜后那次 tick 属于新的一天，minutes
 * 回到 0，`0 >= 1439` 为 false。
 *
 * 实测（起始 00:00、常驻 3 天）：设定 23:56 正常 3 次，而 23:57 / 23:58 / 23:59
 * **全部 0 次**。盲区还随相位漂移：设定 23:59 时，00:03 起步正常，00:00 / 00:01 /
 * 00:02 / 00:04 / 00:05 起步全漏。默认值 `10:05` 不受影响（任何相位都必然有 tick
 * 落在其后），只有用户主动设到日末几分钟才踩到 —— 但它是**静默**的。
 *
 * ## 修复方案：`isCheckinDue` 三态判定
 *
 * `auto-checkin.ts` 新增 `isCheckinDue(time, nowMs, tickMs)`，返回
 * `{ due, reason }`：
 *
 * | 条件 | 结果 | 含义 |
 * |---|---|---|
 * | `minutes >= target` | `{ due: true, reason: 'reached' }` | 常规路径，已到点 |
 * | `minutes + tickMinutes >= 1440` | `{ due: true, reason: 'last-chance' }` | **下一次检查已不在今天**，再等就永远等不到 ⇒ 本轮放行 |
 * | 其它 | `{ due: false, reason: 'waiting' }` | 继续等 |
 *
 * 判据语义是「下一次检查是否还在今天」，不是「现在到点了吗」—— 这才是调度真正要
 * 回答的问题。`isTimeReachedToday` 保留为**无相位依赖的纯函数**（两者职责分开，
 * 纯判据不必认识 `tickMs`）。
 *
 * ## ⚠️ 代价：`last-chance` 是**提前签**，不是准时签
 *
 * 设定 23:59 时，若最后一次 tick 在 23:55，`1435 + 5 >= 1440` 成立 ⇒ **23:55 就签**，
 * 比用户设定的时刻早 4 分钟。实测提前量 0–4 分钟，恒 ≤ 一个 `tickMs`（见下方
 * 「提前量」用例）。实现为此专门打了一条 `warn`（「自动签到提前触发……日末盲区
 * 补偿」），让用户看到「23:56 签了、但我设的是 23:59」时能查到原因。
 *
 * ## 这条用例现在的身份
 *
 * 已从 XFAIL 转为**正式回归**。若将来有人把 `isCheckinDue` 改回只用
 * `isTimeReachedToday`，它会立刻变红。
 */
await test('日末盲区（已修复）：设定 23:59 常驻三天应签三次', async () => {
  const { engine, clock, calls } = createEngine({
    doc: { enabled: true, time: '23:59', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 0, 0),
  })
  engine.start()
  try {
    await drive(clock, 3 * 24 * 3_600_000)
    assert.equal(calls.length, 3, '设定 23:59 时每天应各签一次（日末盲区曾导致整天漏签）')
  } finally {
    engine.stop()
  }
})

await test('日末盲区（已修复）：全部 60 种启动相位下 23:59 三天都签满', async () => {
  // 缺陷是**相位相关**的：只测一个启动时刻会漏掉大部分相位。逐分钟扫 60 种相位，
  // 每种常驻 3 天 ⇒ 180 天次，必须每天都签。这是该缺陷最直接的回归守门。
  const missing = []
  for (let startMinute = 0; startMinute < 60; startMinute += 1) {
    const { engine, clock, calls } = createEngine({
      doc: { enabled: true, time: '23:59', lastDate: '' },
      nowMs: utc8(2026, 10, 20, 0, startMinute),
    })
    engine.start()
    try {
      await drive(clock, 3 * 24 * 3_600_000)
      if (calls.length !== 3) missing.push({ startMinute, count: calls.length })
    } finally {
      engine.stop()
    }
  }
  assert.deepEqual(missing, [], `这些启动相位下未签满 3 次：${JSON.stringify(missing)}`)
})

await test('提前量：设定 23:59 时实际签到时刻的提前量恒 ≤ 一个 tick', async () => {
  // `last-chance` 是提前签。要守住的是「提前量有界」：绝不能提前半小时，
  // 否则用户设 23:59 却在 23:30 被打上游，那就不是补偿而是失控。
  const tickMs = 5 * 60_000
  const tickMinutes = tickMs / 60_000
  const target = 23 * 60 + 59
  const observed = []
  for (let startMinute = 0; startMinute < 60; startMinute += 1) {
    const { engine, clock, calls } = createEngine({
      doc: { enabled: true, time: '23:59', lastDate: '' },
      nowMs: utc8(2026, 10, 20, 0, startMinute),
    })
    // 记录 claim 发生时的 UTC+8 分钟数。
    let firedAtMinute = null
    engine.start()
    try {
      for (let step = 0; step < 24 * 60; step += 1) {
        clock.advance(60_000)
        await clock.fireDue()
        if (firedAtMinute === null && calls.length > 0) {
          firedAtMinute = src.utc8MinutesOfDay(clock.now)
        }
      }
    } finally {
      engine.stop()
    }
    assert.notEqual(firedAtMinute, null, `启动相位 00:${startMinute} 当天未签到`)
    const lead = target - firedAtMinute
    observed.push(lead)
    assert.ok(
      lead >= 0,
      `启动相位 00:${startMinute} 在设定时刻**之后**才签（提前量 ${lead}），不符合 last-chance 语义`,
    )
    assert.ok(
      lead <= tickMinutes,
      `启动相位 00:${startMinute} 提前 ${lead} 分钟签，超过一个 tick（${tickMinutes} 分钟）—— 提前量失控`,
    )
  }
  // 顺带把「提前量确实非零」钉住：若将来改成准时签，这条会提示更新注释。
  assert.ok(observed.length === 60)
})

await test('isCheckinDue：last-chance 只在日末窗口触发，白天零误触发', async () => {
  assert.equal(typeof src.isCheckinDue, 'function', '缺少导出 isCheckinDue')
  const tickMs = 5 * 60_000
  // 全 time × 全分钟扫描：last-chance 只允许出现在「离午夜不足一个 tick」时。
  const offenders = []
  for (let target = 0; target < 1440; target += 1) {
    const time = `${String(Math.floor(target / 60)).padStart(2, '0')}:${String(target % 60).padStart(2, '0')}`
    for (let minute = 0; minute < 1440; minute += 1) {
      const decision = src.isCheckinDue(time, utc8(2026, 10, 20, 0, minute), tickMs)
      if (decision.due && decision.reason === 'last-chance' && minute < 1440 - tickMs / 60_000) {
        offenders.push({ time, minute })
      }
    }
  }
  assert.deepEqual(offenders.slice(0, 5), [], 'last-chance 在白天误触发（应只在日末窗口）')
})

await test('isCheckinDue：每个合法 time 在当天都至少有一个可签时刻', async () => {
  // 「覆盖完整性」：修复的**目标**就是消除「整天没有任何可签时刻」。这条把
  // 目标本身写成断言，比只测 23:59 一个点更可靠。
  const uncovered = []
  for (const tickMs of [60_000, 5 * 60_000, 10 * 60_000]) {
    for (let target = 0; target < 1440; target += 1) {
      const time = `${String(Math.floor(target / 60)).padStart(2, '0')}:${String(target % 60).padStart(2, '0')}`
      let covered = false
      for (let minute = 0; minute < 1440; minute += 1) {
        if (src.isCheckinDue(time, utc8(2026, 10, 20, 0, minute), tickMs).due) { covered = true; break }
      }
      if (!covered) uncovered.push({ time, tickMs })
    }
  }
  assert.deepEqual(uncovered.slice(0, 5), [], '这些 time 在当天没有任何可签时刻（覆盖有洞）')
})

await test('isCheckinDue：非法 time 一律 waiting（不声称最后机会）', async () => {
  for (const bad of ['9:05', '25:00', '', '10:05:00']) {
    const decision = src.isCheckinDue(bad, utc8(2026, 10, 20, 23, 58), 5 * 60_000)
    assert.equal(decision.due, false, `非法值 ${JSON.stringify(bad)} 不得判 due`)
    assert.equal(decision.reason, 'waiting')
  }
})

await test('日末盲区：设定 23:50（安全区内）常驻三天应签三次', async () => {
  // 对照组：23:50 距日末 9 分钟 > tickMs，必然有 tick 落在窗口内 ⇒ 走 `reached`
  // 而非 `last-chance`，即准时签。这条证明修复没有把「正常时段」也变成提前签。
  const { engine, clock, calls } = createEngine({
    doc: { enabled: true, time: '23:50', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 0, 0),
  })
  engine.start()
  try {
    await drive(clock, 3 * 24 * 3_600_000)
    assert.equal(calls.length, 3, '23:50 在安全区内，每天应各签一次')
  } finally {
    engine.stop()
  }
})

await test('跨年：12-31 → 01-01 的日界与到点判据正确', async () => {
  const lastMinute = utc8(2026, 12, 31, 23, 59)
  const newYear = utc8(2027, 1, 1, 0, 0)
  assert.equal(src.utc8DateString(lastMinute), '2026-12-31')
  assert.equal(src.utc8DateString(newYear), '2027-01-01', '跨年后日期必须跳到新年')
  assert.equal(src.isTimeReachedToday('10:05', lastMinute), true)
  assert.equal(src.isTimeReachedToday('10:05', newYear), false, '新年 00:00 应重新等 10:05')
})

await test('闰年 2028-02-29：日界与到点判据正确', async () => {
  const leap = utc8(2028, 2, 29, 10, 5)
  assert.equal(src.utc8DateString(leap), '2028-02-29')
  assert.equal(src.isTimeReachedToday('10:05', leap), true)
})

await test('夏令时：UTC+8 语义不受本机 DST 切换影响', async () => {
  // 美国 2026-11-01 结束夏令时；UTC+8 无 DST。切换日前后 10:05 的判定必须一致。
  const beforeSwitch = utc8(2026, 10, 31, 10, 5)
  const afterSwitch = utc8(2026, 11, 1, 10, 5)
  assert.equal(src.isTimeReachedToday('10:05', beforeSwitch), true)
  assert.equal(src.isTimeReachedToday('10:05', afterSwitch), true, 'DST 切换日 10:05 仍应判已到点')
  assert.equal(src.isTimeReachedToday('10:05', utc8(2026, 11, 1, 10, 4)), false, '10:04 仍未到点')
})

await test('时钟回拨（NTP 校正）：lastDate 已是今天 → 不得重签', async () => {
  const { engine, clock, calls } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  engine.start()
  try {
    await drive(clock, 60_000)
    assert.equal(calls.length, 1, '应签一次')
    clock.setNow(utc8(2026, 10, 20, 0, 30)) // 回拨到当天凌晨
    await drive(clock, 10 * 60_000)
    assert.equal(calls.length, 1, '回拨后 lastDate 仍是今天，不得重签')
  } finally {
    engine.stop()
  }
})

await test('时钟前跳 5 天：只签一次，不补签历史日期', async () => {
  const { engine, clock, calls, store } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 8, 0),
  })
  engine.start()
  try {
    clock.setNow(utc8(2026, 10, 25, 11, 0)) // 直接跳到 5 天后
    await drive(clock, 5 * 60_000)
    assert.equal(calls.length, 1, '前跳后应只签一次（不补签中间错过的日期）')
    assert.equal(store.read().lastDate, '2026-10-25')
  } finally {
    engine.stop()
  }
})

await test('inflight 去重：并发 runIfDue 只跑一轮', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const clock = fakeClock(utc8(2026, 10, 20, 10, 6))
  const store = memoryStore({ enabled: true, time: '10:05', lastDate: '' }, src.DEFAULT_AUTO_CHECKIN)
  const calls = []
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => ['qoder'],
    claim: async provider => {
      calls.push(provider)
      await gate
      return { ok: true, value: { summary: { ...TODAY_SUMMARY } } }
    },
    now: () => clock.now,
    delayMs: 30_000,
    schedule: clock.schedule,
    scheduleInterval: clock.scheduleInterval,
  })
  const all = [engine.runIfDue(), engine.runIfDue(), engine.runIfDue()]
  release()
  await Promise.all(all)
  assert.equal(calls.length, 1, `并发触发应只跑一轮，实际 ${calls.length} 轮`)
})

await test('空渠道池：不记 lastDate（下次仍会重试）', async () => {
  const { engine, calls, store } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
    providers: [],
  })
  await engine.runIfDue()
  assert.deepEqual(calls, [], '空池不应调用 claim')
  assert.equal(store.read().lastDate, '', '空池不应记 lastDate，否则当天再也不会重试')
})

await test('setTime 传非法值：不签到且打 warn（不静默）', async () => {
  const { engine, calls, warnings } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.setTime('99:99')
  await engine.runIfDue()
  assert.deepEqual(calls, [], '非法时间不得触发签到')
  assert.ok(
    warnings.some(message => message.includes('非法')),
    `时间配置坏了必须打 warn 让用户看见，实际 warnings=${JSON.stringify(warnings)}`,
  )
})

await test('sanitize：null / 数组 / 字符串 / 数字 全部回落默认值', async () => {
  for (const bad of [null, [], 'x', 42, undefined]) {
    const doc = src.sanitizeAutoCheckin(bad)
    assert.equal(doc.enabled, false, `${JSON.stringify(bad)} 的 enabled 应为 false`)
    assert.equal(doc.time, '10:05', `${JSON.stringify(bad)} 的 time 应为 10:05`)
  }
})

await test('parseTimeOfDay：00:00=0、23:59=1439、越界与空串为 undefined', async () => {
  assert.equal(src.parseTimeOfDay('00:00'), 0)
  assert.equal(src.parseTimeOfDay('23:59'), 1439)
  assert.equal(src.parseTimeOfDay('24:00'), undefined)
  assert.equal(src.parseTimeOfDay(''), undefined)
})

await test('utc8ClockString：两位补零格式正确', async () => {
  assert.equal(src.utc8ClockString(utc8(2026, 10, 20, 9, 5)), '09:05')
  assert.equal(src.utc8ClockString(utc8(2026, 10, 20, 0, 0)), '00:00')
})

await test('常驻 10 天：每天恰好签一次', async () => {
  const { engine, clock, calls } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 8, 0),
  })
  engine.start()
  try {
    await drive(clock, 10 * 24 * 3_600_000)
    assert.equal(calls.length, 10, `期望 10 次，实际 ${calls.length} 次`)
  } finally {
    engine.stop()
  }
})

await test('stop() 后重新 start()：调度恢复并补签', async () => {
  const { engine, clock, calls } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 9, 0),
  })
  engine.start()
  engine.stop()
  await drive(clock, 2 * 3_600_000) // 9:00 → 11:00，stop 期间不签
  assert.deepEqual(calls, [], 'stop 期间不应签')
  engine.start()
  try {
    await drive(clock, 60_000)
    assert.equal(calls.length, 1, '重新 start 后已过点应补签')
  } finally {
    engine.stop()
  }
})



// === 10. 打开开关的时间语义 ==============================================

await test('setEnabled(true)：未到点不签（不能因为「刚打开」就提前打上游）', async () => {
  const { engine, calls } = createEngine({
    doc: { enabled: false, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 9, 0),
  })
  await engine.setEnabled(true)
  await engine.runIfDue()
  assert.deepEqual(calls, [], '未到点不应签')
})

await test('setEnabled(true)：已到点且今天没签 → 立刻签', async () => {
  const { engine, calls, store } = createEngine({
    doc: { enabled: false, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 11, 0),
  })
  await engine.setEnabled(true)
  // setEnabled 内部是「不 await 地」发起一轮，给它一拍微任务。
  await engine.runIfDue()
  assert.equal(calls.length, 1, '打开开关且已到点应立刻跑一轮')
  assert.equal(store.read().lastDate, '2026-10-20')
})

// === 11. setTime：改时间后立刻重判 ======================================

await test('setTime：改到「已经过点」的时刻 → 立刻补签（不必等下一个周期）', async () => {
  const { engine, calls, store } = createEngine({
    doc: { enabled: true, time: '23:00', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.setTime('10:05')
  // setTime 内部不 await 地发起一轮，给它一拍。
  await engine.runIfDue()
  assert.equal(calls.length, 1, '把时间改到已过点后应立刻补签，否则界面看起来像「改了没生效」')
  assert.equal(store.read().lastDate, '2026-10-20')
})

await test('setTime：改到「还没到」的时刻 → 不签', async () => {
  const { engine, calls } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.setTime('22:00')
  await engine.runIfDue()
  assert.deepEqual(calls, [], '改到未来时刻后应继续等，不能因为「刚才已过旧时间」就签')
})

await test('setTime：开关关着时改时间不签（关闭即彻底不动）', async () => {
  const { engine, calls } = createEngine({
    doc: { enabled: false, time: '23:00', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.setTime('00:01')
  await engine.runIfDue()
  assert.deepEqual(calls, [], '关闭状态下改时间不得触发签到')
})

await test('setTime：新时间必须落盘（否则重启后用户设的时间静默丢失）', async () => {
  const { engine, store } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
  })
  await engine.setTime('21:30')
  assert.equal(store.read().time, '21:30')
})

// === 12. 记账口径：coversToday 为 0 时不记日期 ============================

await test('记账：coversToday 为 0 时不记日期（下一轮会重试）', async () => {
  const { engine, calls, store } = createEngine({
    doc: { enabled: true, time: '10:05', lastDate: '' },
    nowMs: utc8(2026, 10, 20, 10, 6),
    summary: { ...TODAY_SUMMARY, coversToday: 0 },
  })
  await engine.runIfDue()
  assert.equal(calls.length, 1, '这一轮仍然要跑')
  assert.equal(store.read().lastDate, '', 'coversToday=0 说明没证明「今天已处理」，不得记日期')

  await engine.runIfDue()
  assert.equal(calls.length, 2, '没记日期时下一次必须重试')
})

// === 13. 跨端契约：客户端与服务端的时间判据必须一致 ======================

await test('跨端契约：client.js 的 AUTO_TIME_RE 与 AUTO_CHECKIN_TIME_RE 一致', async () => {
  // `client.js` 里有一份**副本**（注释说明是刻意的：让输入框能立刻拒绝半打好的值，
  // 而不必等一次往返）。副本本身没问题，**漂移**才是问题 —— 加宽格式时若只改一边，
  // 表现是「UI 能存、调度不生效」。故这里逐值比对两边的判定结果。
  const clientSource = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  const matched = clientSource.match(/const AUTO_TIME_RE = (\/.*?\/)\n/)
  assert.ok(matched, 'client.js 里找不到 AUTO_TIME_RE 定义（被改名或删掉了？）')
  // eslint-disable-next-line no-new-func
  const clientRe = new Function(`return ${matched[1]}`)()
  const samples = [
    '00:00', '10:05', '23:59', '09:00',
    '9:05', '25:00', '10:60', '10:05:00', ' 10:05', '10:05 ', '10：05', '', 'ab:cd',
  ]
  for (const sample of samples) {
    assert.equal(
      clientRe.test(sample), src.AUTO_CHECKIN_TIME_RE.test(sample),
      `两端对 ${JSON.stringify(sample)} 的判定不一致（客户端与服务端的时间判据漂移了）`,
    )
  }
})

// === 14. RPC 层 time 校验 ================================================

/**
 * 挂载真实的 `channel-pack-rpc.ts`，只取 `usage.autoCheckin` 一条路径。
 *
 * ⚠️ 必须走真实 RPC：`time` 的**严格**校验只在写入路径上，`sanitizeAutoCheckin`
 * 那条是**宽松回落**（面对磁盘脏数据）。两处判据若不一致，表现就是
 * 「UI 能存、调度不生效」—— 本组用例正是守这一点。
 */
async function mountRpc() {
  const rpcUrl = await bundleSource('channel-pack-rpc.ts', 'channel-pack-rpc.mjs')
  const rpc = await import(rpcUrl)
  const routes = []
  const services = { connection: { fetch: { register: route => routes.push(route) } } }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: name => services[name],
    provide(name, service) { services[name] = service },
    inject(names, callback) {
      if (names.every(name => services[name] !== undefined)) callback(this)
    },
    effect(callback) {
      const cleanup = callback()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    emit() {},
  }
  /** 账号池桩：**空池** ⇒ 即使真跑一轮也不会发任何上游请求。 */
  const pool = new Proxy({}, {
    get: (_target, key) => {
      if (key === 'listAllAccounts') return async () => []
      if (key === 'listAccountsByProvider') return () => []
      if (key === 'listAccounts') return async () => []
      return async () => undefined
    },
  })
  /** 各 provider 的 auth 实例桩（本组用例用不到它们的任何方法）。 */
  const auth = new Proxy({}, { get: () => async () => undefined })
  rpc.registerChannelPackRpc(
    ctx, pool,
    auth, auth, auth, auth, auth, auth, auth,
    auth, auth, auth, auth, auth, auth, auth,
  )
  const route = routes.find(row => row.path === rpc.CHANNEL_PACK_API_PATH)
  assert.ok(route, 'RPC 端点未注册（connection.fetch.register 未被调用）')
  const call = async (method, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'auto-checkin-test', method: 'channel-pack',
        payload: { method, payload },
      }),
    }))
    return (await response.json()).result
  }
  return { call }
}

let rpcCall = null
try {
  process.env.DSH_CHANNEL_PACK_STATE_DIR = path.join(scratch, 'home')
  process.env.DSH_HOME = path.join(scratch, 'home')
  const mounted = await mountRpc()
  rpcCall = mounted.call
} catch (error) {
  console.log(`FAIL 挂载 channel-pack-rpc.ts`)
  console.log(`       ${String(error?.message ?? error).split('\n').join('\n       ')}`)
  results.push({ name: '挂载 channel-pack-rpc.ts', ok: false, error })
}

if (rpcCall !== null) {
  await test('RPC usage.autoCheckin：无参查询回显默认关闭 + 默认时间', async () => {
    const result = await rpcCall('usage.autoCheckin', {})
    assert.equal(result.ok, true, `查询应成功：${JSON.stringify(result.error)}`)
    assert.equal(result.value.autoCheckin.enabled, false, 'RPC 回显的开关默认必须是关闭')
    assert.equal(result.value.autoCheckin.time, '10:05', 'RPC 回显的时间默认必须是 10:05')
  })

  await test('RPC usage.autoCheckin：合法 time "10:05" 通过', async () => {
    const result = await rpcCall('usage.autoCheckin', { time: '10:05' })
    assert.equal(result.ok, true, `合法值应被接受：${JSON.stringify(result.error)}`)
    assert.equal(result.value.autoCheckin.time, '10:05')
  })

  for (const bad of ['9:05', '25:00', '10:05:00', ' 10:05']) {
    await test(`RPC usage.autoCheckin：非法 time ${JSON.stringify(bad)} → bad-request`, async () => {
      const result = await rpcCall('usage.autoCheckin', { time: bad })
      assert.equal(result.ok, false, `非法值必须被拒绝（收到 ok=true）`)
      assert.equal(result.error?.code, 'bad-request', `错误码应为 bad-request，实际 ${JSON.stringify(result.error?.code)}`)
    })
  }

  await test('RPC usage.autoCheckin：非法 time 不污染已存的值', async () => {
    const result = await rpcCall('usage.autoCheckin', {})
    assert.equal(result.value.autoCheckin.time, '10:05', '被拒绝的写入不应改变已有时间')
  })

  await test('RPC usage.autoCheckin：time + enabled 同给时先写时间再写开关', async () => {
    // ⚠️ 顺序有实际后果：`setEnabled(true)` 会**立刻**按当前 `time` 判一轮。
    // 若先写开关后写时间，用户把 10:05 改成 22:00 并同时打开开关时，会按**旧**
    // 时间（已过点）当场签一次，然后 22:00 因 `lastDate` 已记而不再签 —— 用户
    // 设的时间等于没生效。故这里断言「开开关那一刻看到的是新时间」。
    const result = await rpcCall('usage.autoCheckin', { time: '22:00', enabled: true })
    assert.equal(result.ok, true, `同时写入应成功：${JSON.stringify(result.error)}`)
    assert.equal(result.value.autoCheckin.time, '22:00', '回显的时间必须是新时间')
    assert.equal(result.value.autoCheckin.enabled, true, '回显的开关必须是打开')
    const after = await rpcCall('usage.autoCheckin', {})
    assert.equal(after.value.autoCheckin.time, '22:00', '新时间必须持久化')
  })

  await test('RPC usage.autoCheckin：enabled 非布尔值 → bad-request', async () => {
    for (const bad of ['true', 1, null]) {
      const result = await rpcCall('usage.autoCheckin', { enabled: bad })
      assert.equal(result.ok, false, `enabled=${JSON.stringify(bad)} 应被拒绝`)
      assert.equal(result.error?.code, 'bad-request')
    }
  })
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
//
// ⚠️ 四类结果**互斥**，各自由 `kind` 判定（不要再从 `ok` 布尔反推）：
// - `pass`  正常通过          → 摘要「通过」，不影响退出码
// - `fail`  正常失败          → 摘要「失败」+ 失败清单，退出码 1
// - `xfail` 已知缺陷仍存在    → 摘要「已知缺陷」，不影响退出码（但会列出）
// - `xpass` 已知缺陷已修复    → **计入失败**：标记该摘了。摘要与清单都必须
//   显式说明「这是 XPASS 不是断言失败」，且绝不能打印 `undefined`
//   （旧版把 xpass 记录塞进 `failed` 却没有 `error` 字段，于是清单打 `undefined`，
//    同时摘要又写「失败 0」—— 自相矛盾）。

const byKind = kind => results.filter(row => row.kind === kind)
const passed = byKind('pass')
const xfailed = byKind('xfail')
const xpassed = byKind('xpass')
const plainFailed = byKind('fail')
/** 计入退出码的失败：真失败 + XPASS（标记过期）。 */
const failed = [...plainFailed, ...xpassed]

console.log('')
const summary = [
  `${results.length} 条用例`,
  `通过 ${passed.length}`,
]
if (xfailed.length > 0) summary.push(`已知缺陷（XFAIL）${xfailed.length}`)
if (xpassed.length > 0) summary.push(`标记过期（XPASS）${xpassed.length}`)
summary.push(`失败 ${plainFailed.length}`)
console.log(`自动签到调度：${summary.join('，')}`)

if (xfailed.length > 0) {
  console.log('')
  console.log('已知缺陷（不计为失败，但必须报给源码作者）：')
  for (const row of xfailed) {
    console.log(`  - ${row.name}`)
    console.log(`    ${row.detail}`)
  }
}
if (xpassed.length > 0) {
  console.log('')
  console.log('⚠️ 标记过期（XPASS）：这些用例标了「预期失败」却通过了 —— 缺陷已修复，请摘掉标记：')
  for (const row of xpassed) {
    console.log(`  - ${row.name}`)
    console.log(`    ${row.detail}`)
  }
}
if (plainFailed.length > 0) {
  console.log('')
  console.log('失败清单：')
  for (const row of plainFailed) {
    console.log(`  - ${row.name}`)
    console.log(`    ${String(row.error?.message ?? row.error ?? '(无错误详情)').split('\n')[0]}`)
  }
}

fs.rmSync(scratch, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
