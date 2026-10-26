/**
 * 自动签到「逐渠道」调度回归：默认值、迁移、UTC+8 判据、逐渠道独立性、跨天重触发、RPC 契约。
 *
 *     node scripts/auto-checkin-schedule-test.mjs
 *
 * ## 它守的是什么
 *
 * 本功能改过三次，每次都有**一条**最容易复发的缺口，本文件按它们组织：
 *
 * 1. **2026-10-19**「启动即签」→「每天到点签」。旧缺口：进程常驻不重启 ⇒ 第二天
 *    永远不再签（「每日」退化成「每次启动」）。守它的是
 *    {@link 定时器驱动跨天}。
 * 2. **2026-10-23** 日末盲区：设定时间落在「当天最后一个 tick 之后、午夜之前」时
 *    当天永远观察不到 `>= target` ⇒ 整天静默漏签。守它的是
 *    {@link 日末盲区}（60 种启动相位 × 3 天）。
 * 3. **2026-10-24** 全局 → **逐渠道**。旧模型只有一个全局开关 + 一个全局时间，
 *    作用范围写死成「账号池里所有渠道」，用户无法表达「这个签、那个不签」。
 *    守它的是第 5 组（独立性 / 独立时间 / 独立记账）与第 9 组（迁移）。
 *
 * ## 零等待、零网络、零本机时区依赖
 *
 * 三条硬约束，缺一条本文件就会变成「跑得慢又不稳」的噪声源：
 *
 * 1. **假时钟**：`AutoCheckinDeps.now()` 注入可变时间戳，跨天只是改一个整数；
 * 2. **假定时器**：`schedule` / `scheduleInterval` 把回调连同「到期时刻」收进队列，
 *    由 {@link fakeClock} 按需 `fireDue()`。绝不真等 5 分钟，也不依赖
 *    `setInterval` 的真实语义；
 * 3. **假时区**：见文件顶部对 `process.env.TZ` 的赋值 —— 本文件在**非 UTC+8** 的
 *    时区下运行。被测代码若误用 `getHours()`（本机时区）而不是算术平移，
 *    UTC+8 那一组断言会立刻红，而不是「在开发者机器上恰好通过」。
 *
 * `claim` 是桩函数，只记录被调了哪个渠道，绝不发真实上游请求。
 *
 * ## 被测代码怎么加载
 *
 * `auto-checkin.ts` 是 TypeScript 源码，本仓库没有 `tsc` 运行期加载路径，但
 * `node_modules` 里有 esbuild（`scripts/build-channel-pack.mjs` 用的同一个）。
 * 故这里用 esbuild 即时打成临时 ESM，再 `import()`。`@deepseek-ai/*` 是宿主提供
 * 的模块，用 `scripts/lib/channel-pack-kernel.mjs`（已有的最小宿主契约替身）
 * 在 resolve 阶段短路，与 `scripts/channel-pack-test.mjs` 的 `--source` 模式同款。
 *
 * RPC 那一组（`usage.autoCheckin` 的 `provider` / `time` / `enabled` 校验）要挂载
 * 真实的 `channel-pack-rpc.ts`：它是唯一能证明「客户端能存的值 = 调度认的值」的
 * 地方，在 `auto-checkin.ts` 里再写一遍校验会漂移。
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

/** 一天的毫秒数（用例里的常客）。 */
const DAY_MS = 24 * 3_600_000

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
      console.log(`       已知缺陷似乎已修复（${reason}）—— 请把该用例的 expectedToFail 摘掉转成正式回归`)
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

/** 按需解析 esbuild（走 CJS 解析，与 `build-channel-pack.mjs` 同款，兼容 NODE_PATH）。
 *
 *  根目录的 package.json 并不声明 esbuild，它只随 `packages/standalone` 装进来；
 *  只从根解析会在干净的 checkout 上直接 ERR_MODULE_NOT_FOUND。因此依次尝试
 *  根、standalone、NODE_PATH 三处，全都没有才按「环境不具备」跳过——代码本身
 *  仍可在装了 esbuild 的机器上被完整验证。 */
async function loadEsbuild() {
  if (esbuild !== undefined) return esbuild
  const candidates = [
    path.join(root, 'package.json'),
    path.join(root, 'packages', 'standalone', 'package.json'),
  ]
  for (const from of candidates) {
    try {
      const resolved = createRequire(from).resolve('esbuild')
      esbuild = await import(pathToFileURL(resolved).href)
      return esbuild
    } catch { /* try the next resolution root */ }
  }
  console.log('ok  自动签到调度 skipped: esbuild is not installed (the offline job installs nothing)')
  process.exit(0)
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
 * ⚠️ 必须**深拷贝**进出：被测代码会原地写 `doc.providers[id]`（见 `performRun`），
 * 浅拷贝会让 `read()` 拿到同一个 `providers` 对象 —— 断言就变成了「自己跟自己
 * 比较」，永远为真。
 */
function memoryStore(doc) {
  let current = structuredClone(doc)
  return {
    kind: 'memory',
    load: () => structuredClone(current),
    save: async next => { current = structuredClone(next) },
    read: () => structuredClone(current),
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
      cancel() { timer.cancelled = true },
    }
    state.timers.push(timer)
    return timer
  }
  const isDue = row => !row.cancelled && !row.done && row.due <= state.now
  const clock = {
    schedule: (fn, ms) => makeTimer(fn, ms, false),
    scheduleInterval: (fn, ms) => makeTimer(fn, ms, true),
    advance: deltaMs => { state.now += deltaMs },
    setNow: nextMs => { state.now = nextMs },
    async fireDue() {
      // 上界只为防「回调里排定了 due<=now 的定时器」把本函数变成死循环。
      for (let guard = 0; guard < 100_000; guard += 1) {
        const due = state.timers.filter(isDue).sort((left, right) => left.due - right.due)
        if (due.length === 0) return
        const timer = due[0]
        if (timer.repeat) timer.due += timer.ms
        else timer.done = true
        await timer.fn()
        // 抽干微任务：`runIfDue` 是「发起即返回」，不抽干就读不到 claim 计数。
        await drainMicrotasks()
      }
    },
    /** 尚未到期的一次性定时器（周期定时器不在此列：它「永远在转」）。 */
    pending: () => state.timers.filter(row => !row.cancelled && !row.done && !row.repeat),
    intervals: () => state.timers.filter(row => row.repeat),
    liveIntervals: () => state.timers.filter(row => row.repeat && !row.cancelled),
    timers: state.timers,
    get now() { return state.now },
  }
  return clock
}

/**
 * 抽干微任务队列（零等待）。
 *
 * `setProviderEnabled(true)` / `setProviderTime` 内部是**不 await** 地发起一轮
 * （理由见源码注释：不能让按钮等一整轮上游请求）。用例要断言那一轮的**副作用**，
 * 就得让微任务先跑完。这里不用 `setTimeout` / `setImmediate`：本文件的硬约束是
 * 「零等待」，而纯 Promise 链足以抽干被测代码的全部 await 点（它不碰 I/O）。
 */
async function drainMicrotasks(rounds = 100) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
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

/**
 * 「今天这一轮已被处理」的默认 summary（`coversToday` 为 1 ⇒ 会记日期）。
 *
 * 每个用例拿到的是**副本**：`claimRecorder` 与 `createEngine` 都会展开它，
 * 避免某个用例改了字段后影响后面所有用例。
 */
const TODAY_SUMMARY = {
  claimed: 1,
  totalCredit: 100,
  totalByUnit: { credit: 100, token: 0 },
  alreadyClaimed: 0,
  inactive: 0,
  failed: 0,
  coversToday: 1,
}

/**
 * claim 桩：记录被调的渠道，返回可控的信封。
 *
 * @param summary - 成功时的 `summary`。
 * @param failFor - 这些渠道返回 `ok: false`（模拟失败，用于「独立记账」用例）。
 */
function claimRecorder(summary, failFor = []) {
  const calls = []
  const claim = async provider => {
    calls.push(provider)
    if (failFor.includes(provider)) {
      return { ok: false, error: { code: 'bad-request', message: `模拟失败：${provider}` } }
    }
    return { ok: true, value: { summary: { ...summary, totalByUnit: { ...summary.totalByUnit } } } }
  }
  return { calls, claim }
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

/** 单渠道配置的简写：只写关心的字段，其余取默认值（与 `sanitizeProviderDoc` 同口径）。 */
const pdoc = (overrides = {}) => ({ ...src.defaultProviderDoc(), ...overrides })

/** 空文档（全关 + 无记录），逐渠道用例的起点。 */
const emptyDoc = () => ({ ...structuredClone(src.DEFAULT_AUTO_CHECKIN), providers: {} })

/**
 * 建一个注入了假时钟/假定时器/桩 claim 的执行体。
 *
 * @param doc - 初始文档（会被深拷贝）。
 * @param nowMs - 假时钟起点。
 * @param providers - 账号池里的渠道 id。
 * @param summary - claim 成功时的 summary。
 * @param failFor - 这些渠道的 claim 返回失败。
 */
function createEngine({
  doc = emptyDoc(),
  nowMs,
  providers = ['qodercn'],
  summary = TODAY_SUMMARY,
  failFor = [],
} = {}) {
  const clock = fakeClock(nowMs)
  const store = memoryStore(doc)
  const recorder = claimRecorder(summary, failFor)
  const warnings = []
  const debugs = []
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
    debug: message => debugs.push(message),
  })
  return { engine, clock, store, calls: recorder.calls, warnings, debugs }
}

/** 取 `state().providers` 里某个渠道的那一项（找不到返回 undefined）。 */
const providerState = (engine, provider) =>
  engine.state().providers.find(entry => entry.provider === provider)

// === 0. 前提：本机时区确实不是 UTC+8 =====================================

await test('前提：本机时区非 UTC+8（否则时区相关断言无意义）', () => {
  // UTC+8 的 10:05，其本机墙上时间在 America/New_York 是**前一天** 22:05。
  const localHour = new Date(utc8(2026, 10, 20, 10, 5)).getHours()
  assert.notEqual(localHour, 10, `本机时区仍是 UTC+8（getHours()=${localHour}），时区断言会失去意义`)
  // 顺带把「差一天」这件事钉住：这才是误用本机时区时会踩到的形态。
  assert.equal(new Date(utc8(2026, 10, 20, 10, 5)).getDate(), 19)
})

// === 1. 默认值：逐渠道模型全关 ============================================

await test('默认值：DEFAULT_AUTO_CHECKIN 没有任何渠道（providers 为空）', () => {
  assert.deepEqual(src.DEFAULT_AUTO_CHECKIN.providers, {}, '默认文档不得预置任何渠道条目')
  assert.equal(src.DEFAULT_AUTO_CHECKIN.lastAt, 0)
  assert.equal(src.DEFAULT_AUTO_CHECKIN.dismissedRunAt, 0)
  assert.deepEqual(src.DEFAULT_AUTO_CHECKIN.channels, [])
})

await test('默认值：defaultProviderDoc() 是「关闭 + 10:05 + 无记录」', () => {
  assert.deepEqual(src.defaultProviderDoc(), {
    enabled: false,
    time: '10:05',
    lastDate: '',
    lastResult: '',
    lastAt: 0,
  })
})

await test('默认值：defaultProviderDoc() 每次返回**新对象**（不能共享引用）', () => {
  // 共享引用会让「改 A 的开关」顺带改掉默认值，进而污染所有未配置的渠道。
  const first = src.defaultProviderDoc()
  const second = src.defaultProviderDoc()
  assert.notEqual(first, second, '两次调用返回了同一个对象')
  first.enabled = true
  assert.equal(src.defaultProviderDoc().enabled, false, '默认值被上一次调用污染了')
})

await test('默认值：DEFAULT_AUTO_CHECKIN_TIME 是 10:05（UTC+8）', () => {
  assert.equal(src.DEFAULT_AUTO_CHECKIN_TIME, '10:05')
})

// === 2. sanitizeProviderDoc：单渠道归一化 =================================

for (const [raw, expected, label] of [
  [{ enabled: true }, true, '显式 true'],
  [{}, false, '无 enabled 字段'],
  [{ enabled: 'true' }, false, '字符串 "true"'],
  [{ enabled: false }, false, '显式 false'],
  [{ enabled: 1 }, false, '数字 1'],
  [{ enabled: null }, false, 'null'],
  [{ enabled: undefined }, false, 'undefined'],
  [{ enabled: 'yes' }, false, '字符串 "yes"'],
]) {
  await test(`sanitizeProviderDoc.enabled：${label} → ${expected ? '打开' : '关闭'}`, () => {
    const doc = src.sanitizeProviderDoc(raw)
    assert.equal(doc.enabled, expected, `输入 ${JSON.stringify(raw)} 的 enabled 判据错误`)
  })
}

for (const [raw, expected, label] of [
  [{}, '10:05', '无 time 字段 → 回落默认'],
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
  await test(`sanitizeProviderDoc.time：${label}`, () => {
    assert.equal(src.sanitizeProviderDoc(raw).time, expected, `输入 ${JSON.stringify(raw)} 的 time 归一化错误`)
  })
}

await test('sanitizeProviderDoc.time：非法值不得被「宽松修正」成合法值（不补零、不截断）', () => {
  // 与 RPC 严格校验同口径：`'9:05'` 不能悄悄变成 `'09:05'`，否则 UI 能存、调度不生效。
  assert.notEqual(src.sanitizeProviderDoc({ time: '9:05' }).time, '09:05')
  assert.notEqual(src.sanitizeProviderDoc({ time: '10:05:00' }).time, '10:05:00')
})

await test('sanitizeProviderDoc.lastDate：只接受 YYYY-MM-DD，其余归空串', () => {
  assert.equal(src.sanitizeProviderDoc({ lastDate: '2026-10-24' }).lastDate, '2026-10-24')
  for (const bad of ['', '2026-1-4', '20261024', 20261024, null, undefined, 'x']) {
    assert.equal(
      src.sanitizeProviderDoc({ lastDate: bad }).lastDate, '',
      `lastDate=${JSON.stringify(bad)} 应归空串（空串 = 从未跑过）`,
    )
  }
})

await test('sanitizeProviderDoc.lastAt：只接受正数有限值，其余归 0', () => {
  assert.equal(src.sanitizeProviderDoc({ lastAt: 123 }).lastAt, 123)
  for (const bad of [0, -1, '123', null, NaN, Infinity, {}]) {
    assert.equal(src.sanitizeProviderDoc({ lastAt: bad }).lastAt, 0, `lastAt=${String(bad)} 应归 0`)
  }
})

await test('sanitizeProviderDoc.lastResult：截断到 200 字（脏数据不该撑大文档）', () => {
  assert.equal(src.sanitizeProviderDoc({ lastResult: 'x'.repeat(300) }).lastResult.length, 200)
  assert.equal(src.sanitizeProviderDoc({ lastResult: '2 个 +200积分' }).lastResult, '2 个 +200积分')
  assert.equal(src.sanitizeProviderDoc({ lastResult: 42 }).lastResult, '')
})

await test('sanitizeProviderDoc：非对象输入一律回落默认值', () => {
  for (const bad of [null, [], 'x', 42, undefined, true]) {
    assert.deepEqual(
      src.sanitizeProviderDoc(bad), src.defaultProviderDoc(),
      `${JSON.stringify(bad)} 应回落默认值`,
    )
  }
})

// === 3. sanitizeAutoCheckin：迁移口径（旧全局文档 → 空 providers）==========

await test('迁移：旧全局文档 {enabled:true,time:"22:30"} → 产出**空** providers（全关）', () => {
  // ⚠️ 用户 2026-10-24 明确要求「默认为 false」。把旧 `enabled: true` 展开到所有
  // 渠道，会让升级后的用户看到一个自己没开过的开关处于打开状态，无从判断该关哪个。
  const doc = src.sanitizeAutoCheckin({ enabled: true, time: '22:30', lastDate: '2026-10-20' })
  assert.deepEqual(doc.providers, {}, '旧文档不得把 enabled:true 展开到任何渠道')
  assert.equal(doc.lastAt, 0, '旧文档的 lastDate 不属于任何渠道，不得变成顶层 lastAt')
})

await test('迁移：legacyAutoCheckinTime 能取出旧文档的 time（作各渠道初始值）', () => {
  assert.equal(src.legacyAutoCheckinTime({ enabled: true, time: '22:30' }), '22:30')
  assert.equal(src.legacyAutoCheckinTime({ time: '00:00' }), '00:00')
})

await test('迁移：legacyAutoCheckinTime 对非法/缺失时间返回 undefined（调用方用默认值）', () => {
  for (const raw of [
    {}, { time: '9:05' }, { time: 1005 }, { time: '' }, null, undefined, [], 'x', 42,
  ]) {
    assert.equal(
      src.legacyAutoCheckinTime(raw), undefined,
      `${JSON.stringify(raw)} 不该取出时间（应返回 undefined 让调用方回落 10:05）`,
    )
  }
})

await test('迁移：legacyAutoCheckinTime 不取旧 enabled（迁移后必须全关）', () => {
  // 这条守的是「别顺手把 enabled 也搬过来」—— 那正是本迁移唯一容易写错的地方。
  assert.equal(src.legacyAutoCheckinTime({ enabled: true, time: '22:30' }), '22:30')
  assert.deepEqual(src.sanitizeAutoCheckin({ enabled: true, time: '22:30' }).providers, {})
})

await test('sanitizeAutoCheckin：有 providers 时逐渠道归一化，旧全局字段被忽略', () => {
  const doc = src.sanitizeAutoCheckin({
    enabled: true,
    time: '22:30',
    providers: {
      qodercn: { enabled: true, time: '08:00', lastDate: '2026-10-24' },
      trae: { enabled: 'true', time: 'bad' },
    },
  })
  assert.deepEqual(Object.keys(doc.providers).sort(), ['qodercn', 'trae'])
  assert.deepEqual(doc.providers.qodercn, {
    enabled: true, time: '08:00', lastDate: '2026-10-24', lastResult: '', lastAt: 0,
  })
  assert.deepEqual(doc.providers.trae, src.defaultProviderDoc(), 'trae 的脏字段应全部回落')
})

await test('sanitizeAutoCheckin：providers 不是对象（数组 / 字符串 / 数字）→ 空 providers', () => {
  for (const bad of [[], 'x', 42, null, true]) {
    assert.deepEqual(
      src.sanitizeAutoCheckin({ providers: bad }).providers, {},
      `providers=${JSON.stringify(bad)} 应归一化成空对象`,
    )
  }
})

await test('sanitizeAutoCheckin：空字符串渠道键被丢弃（脏数据不该产生幽灵渠道）', () => {
  const doc = src.sanitizeAutoCheckin({ providers: { '': { enabled: true }, qodercn: { enabled: true } } })
  assert.deepEqual(Object.keys(doc.providers), ['qodercn'])
})

await test('sanitizeAutoCheckin：渠道条目上限 24（脏数据不该把文档撑大）', () => {
  const many = {}
  for (let index = 0; index < 40; index += 1) many[`p${index}`] = { enabled: true }
  assert.equal(Object.keys(src.sanitizeAutoCheckin({ providers: many }).providers).length, 24)
})

await test('sanitizeAutoCheckin：null / 数组 / 字符串 / 数字 → 全默认（空 providers）', () => {
  for (const bad of [null, [], 'x', 42, undefined, true]) {
    const doc = src.sanitizeAutoCheckin(bad)
    assert.deepEqual(doc.providers, {}, `${JSON.stringify(bad)} 的 providers 应为空`)
    assert.equal(doc.lastAt, 0)
    assert.deepEqual(doc.channels, [])
  }
})

await test('sanitizeAutoCheckin：channels 只保留合法项并截断到 120 字', () => {
  const doc = src.sanitizeAutoCheckin({
    channels: [
      { provider: 'a', text: 'x'.repeat(200) },
      { provider: '', text: 'y' },
      { provider: 'b' },
      'junk',
      null,
    ],
  })
  assert.equal(doc.channels.length, 1, `只应保留 1 条合法项，实际 ${JSON.stringify(doc.channels)}`)
  assert.equal(doc.channels[0].provider, 'a')
  assert.equal(doc.channels[0].text.length, 120)
})

await test('sanitizeAutoCheckin：lastAt / dismissedRunAt 只接受正数有限值', () => {
  assert.equal(src.sanitizeAutoCheckin({ lastAt: 123, dismissedRunAt: 456 }).lastAt, 123)
  assert.equal(src.sanitizeAutoCheckin({ lastAt: 123, dismissedRunAt: 456 }).dismissedRunAt, 456)
  assert.equal(src.sanitizeAutoCheckin({ lastAt: -1, dismissedRunAt: '9' }).lastAt, 0)
  assert.equal(src.sanitizeAutoCheckin({ lastAt: -1, dismissedRunAt: '9' }).dismissedRunAt, 0)
})

await test('sanitizeAutoCheckin：返回的 providers 是**新对象**（不得污染 DEFAULT_AUTO_CHECKIN）', () => {
  const before = JSON.stringify(src.DEFAULT_AUTO_CHECKIN)
  const doc = src.sanitizeAutoCheckin(null)
  doc.providers.qodercn = pdoc({ enabled: true })
  assert.equal(JSON.stringify(src.DEFAULT_AUTO_CHECKIN), before, 'DEFAULT_AUTO_CHECKIN 被写脏了')
})

// === 4. supportsAutoCheckin：哪些渠道能自动签到 ============================

for (const provider of ['cline', 'workbuddy', 'raccoon']) {
  await test(`supportsAutoCheckin：${provider} 不支持（无签到接口）`, () => {
    assert.equal(src.supportsAutoCheckin(provider), false)
    assert.ok(src.AUTO_CHECKIN_UNSUPPORTED.has(provider), `${provider} 应在 AUTO_CHECKIN_UNSUPPORTED 里`)
  })
}

await test('supportsAutoCheckin：zcode 不支持（有签到但代价高，由排除表拦）', () => {
  assert.equal(src.supportsAutoCheckin('zcode'), false)
  // ⚠️ 语义不同，别混：AUTO_CHECKIN_UNSUPPORTED 答「有没有签到接口」，
  // isAutoCheckinExcluded 答「值不值得自动跑」。zcode 属于后者。
  assert.equal(src.AUTO_CHECKIN_UNSUPPORTED.has('zcode'), false, 'zcode 不该进「无签到接口」名单')
  assert.equal(src.isAutoCheckinExcluded('zcode'), true)
})

for (const provider of ['qodercn', 'trae', 'codearts']) {
  await test(`supportsAutoCheckin：${provider} 支持`, () => {
    assert.equal(src.supportsAutoCheckin(provider), true)
  })
}

await test('supportsAutoCheckin：表外渠道默认视为支持（漏登记不该把真渠道置灰）', () => {
  // 宁可让用户看到一个可以打开、但跑起来会被 isUnsupportedCheckin 判跳过的开关，
  // 也不要因为漏登记而把一个真支持的渠道置灰 —— 后者用户无法自行绕过。
  assert.equal(src.supportsAutoCheckin('some-new-provider'), true)
})

// === 5. UTC+8 时间比较正确性 ==============================================

await test('UTC+8：utc8DateString 在日界两侧正确', () => {
  assert.equal(src.utc8DateString(utc8(2026, 10, 20, 0, 0)), '2026-10-20', 'UTC+8 00:00 属于当天')
  assert.equal(src.utc8DateString(utc8(2026, 10, 20, 23, 59)), '2026-10-20', 'UTC+8 23:59 仍属当天')
  assert.equal(src.utc8DateString(utc8(2026, 10, 20, 0, 0) - 1), '2026-10-19', 'UTC+8 00:00 前一毫秒属前一天')
})

await test('UTC+8：utc8MinutesOfDay 折算出正确的当日分钟数', () => {
  assert.equal(src.utc8MinutesOfDay(utc8(2026, 10, 20, 0, 0)), 0)
  assert.equal(src.utc8MinutesOfDay(utc8(2026, 10, 20, 9, 59)), 599)
  assert.equal(src.utc8MinutesOfDay(utc8(2026, 10, 20, 10, 5)), 605)
  assert.equal(src.utc8MinutesOfDay(utc8(2026, 10, 20, 23, 59)), 1439)
})

await test('UTC+8：isTimeReachedToday 在多个边界点正确（不受本机时区影响）', () => {
  const reached = ms => src.isTimeReachedToday('10:05', ms)
  assert.equal(reached(utc8(2026, 10, 20, 0, 0)), false, 'UTC+8 00:00 未到 10:05')
  assert.equal(reached(utc8(2026, 10, 20, 9, 59)), false, 'UTC+8 09:59 未到')
  assert.equal(reached(utc8(2026, 10, 20, 10, 4)), false, 'UTC+8 10:04 未到')
  assert.equal(reached(utc8(2026, 10, 20, 10, 5)), true, 'UTC+8 10:05 已到（判据是 >=）')
  assert.equal(reached(utc8(2026, 10, 20, 10, 6)), true, 'UTC+8 10:06 已到')
  assert.equal(reached(utc8(2026, 10, 20, 23, 59)), true, 'UTC+8 23:59 已到')
})

await test('UTC+8：跨日后「今天」重新变成未到点（00:00 属于新的一天）', () => {
  assert.equal(src.isTimeReachedToday('10:05', utc8(2026, 10, 20, 23, 59)), true)
  assert.equal(src.isTimeReachedToday('10:05', utc8(2026, 10, 21, 0, 0)), false, '跨日后必须重新等今天的 10:05')
  assert.equal(src.utc8DateString(utc8(2026, 10, 21, 0, 0)), '2026-10-21')
})

await test('UTC+8：非法 time 一律判「未到点」（宁可当天不签，也不在意外时刻打上游）', () => {
  for (const bad of ['9:05', '25:00', '10:05:00', ' 10:05', '']) {
    assert.equal(
      src.isTimeReachedToday(bad, utc8(2026, 10, 20, 23, 0)), false,
      `非法值 ${JSON.stringify(bad)} 不得判成已到点`,
    )
  }
})

await test('parseTimeOfDay：00:00=0、23:59=1439、越界与空串为 undefined', () => {
  assert.equal(src.parseTimeOfDay('00:00'), 0)
  assert.equal(src.parseTimeOfDay('23:59'), 1439)
  assert.equal(src.parseTimeOfDay('24:00'), undefined)
  assert.equal(src.parseTimeOfDay(''), undefined)
})

await test('utc8ClockString：两位补零格式正确', () => {
  assert.equal(src.utc8ClockString(utc8(2026, 10, 20, 9, 5)), '09:05')
  assert.equal(src.utc8ClockString(utc8(2026, 10, 20, 0, 0)), '00:00')
})

await test('跨年：12-31 → 01-01 的日界与到点判据正确', () => {
  assert.equal(src.utc8DateString(utc8(2026, 12, 31, 23, 59)), '2026-12-31')
  assert.equal(src.utc8DateString(utc8(2027, 1, 1, 0, 0)), '2027-01-01', '跨年后日期必须跳到新年')
  assert.equal(src.isTimeReachedToday('10:05', utc8(2026, 12, 31, 23, 59)), true)
  assert.equal(src.isTimeReachedToday('10:05', utc8(2027, 1, 1, 0, 0)), false, '新年 00:00 应重新等 10:05')
})

await test('闰年 2028-02-29：日界与到点判据正确', () => {
  assert.equal(src.utc8DateString(utc8(2028, 2, 29, 10, 5)), '2028-02-29')
  assert.equal(src.isTimeReachedToday('10:05', utc8(2028, 2, 29, 10, 5)), true)
})

await test('夏令时：UTC+8 语义不受本机 DST 切换影响', () => {
  // 美国 2026-11-01 结束夏令时；UTC+8 无 DST。切换日前后 10:05 的判定必须一致。
  assert.equal(src.isTimeReachedToday('10:05', utc8(2026, 10, 31, 10, 5)), true)
  assert.equal(src.isTimeReachedToday('10:05', utc8(2026, 11, 1, 10, 5)), true, 'DST 切换日 10:05 仍应判已到点')
  assert.equal(src.isTimeReachedToday('10:05', utc8(2026, 11, 1, 10, 4)), false, '10:04 仍未到点')
})

// === 6. 逐渠道独立性（本次改造的核心）=====================================

await test('独立性：A 开启、B 关闭 ⇒ 只签 A，B 一次都不调', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: { qodercn: pdoc({ enabled: true }), trae: pdoc({ enabled: false }) },
    },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, ['qodercn'], `只应签 qodercn，实际 ${JSON.stringify(calls)}`)
})

await test('独立性：只有 B 开启 ⇒ 只签 B（A 默认关闭也算关闭）', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: { qodercn: pdoc({ enabled: false }), trae: pdoc({ enabled: true }) },
    },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, ['trae'])
})

await test('独立性：文档里没出现过的渠道一律按「关闭」处理，不签', async () => {
  // 「没配置过」必须等价于关闭：旧写法 `enabled !== false` 会把它判成打开。
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['qodercn', 'trae', 'codearts'],
    doc: { ...emptyDoc(), providers: { trae: pdoc({ enabled: true }) } },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, ['trae'])
})

await test('独立性：两个渠道都开、都到点 ⇒ 两个都签（顺序按账号池稳定序）', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['trae', 'qodercn'],
    doc: {
      ...emptyDoc(),
      providers: { trae: pdoc({ enabled: true }), qodercn: pdoc({ enabled: true }) },
    },
  })
  await engine.runIfDue()
  // 顺序取账号池排序后的结果（resolveDueProviders 用 sort()），不是文档键序。
  assert.deepEqual(calls, ['qodercn', 'trae'], `两个都该签，实际 ${JSON.stringify(calls)}`)
})

await test('各渠道独立时间：A 设 09:00、B 设 22:00 ⇒ 09:00 只签 A，22:00 只签 B', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: {
        qodercn: pdoc({ enabled: true, time: '09:00' }),
        trae: pdoc({ enabled: true, time: '22:00' }),
      },
    },
  })
  clock.setNow(utc8(2026, 10, 24, 9, 5))
  await engine.runIfDue()
  assert.deepEqual(calls, ['qodercn'], `09:05 只该签 qodercn（09:00 到点），实际 ${JSON.stringify(calls)}`)

  calls.length = 0
  clock.setNow(utc8(2026, 10, 24, 22, 5))
  await engine.runIfDue()
  assert.deepEqual(calls, ['trae'], `22:05 只该签 trae（22:00 到点），实际 ${JSON.stringify(calls)}`)
})

await test('各渠道独立时间：时间早的渠道不会因为时间晚的渠道被拖住', async () => {
  // 全局模型下「一个 time 管所有渠道」，晚时间的渠道会让早时间的渠道也跟着等到晚上。
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 0, 30),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: {
        qodercn: pdoc({ enabled: true, time: '09:00' }),
        trae: pdoc({ enabled: true, time: '23:00' }),
      },
    },
  })
  clock.setNow(utc8(2026, 10, 24, 9, 30))
  await engine.runIfDue()
  assert.deepEqual(calls, ['qodercn'])
  assert.equal(providerState(engine, 'trae').ranToday, false, 'trae 还没到 23:00，不该被记今天')
})

await test('各渠道独立记账：A 成功、B 失败 ⇒ A 的 lastDate 记为今天，B 仍为空（下轮重试）', async () => {
  const { engine, store, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['qodercn', 'trae'],
    failFor: ['trae'],
    doc: {
      ...emptyDoc(),
      providers: { qodercn: pdoc({ enabled: true }), trae: pdoc({ enabled: true }) },
    },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, ['qodercn', 'trae'], '两个渠道都要尝试')
  const saved = store.read()
  assert.equal(saved.providers.qodercn.lastDate, '2026-10-24', 'A 成功应记今天')
  assert.equal(saved.providers.trae.lastDate, '', 'B 失败不得记今天（否则当天再也不会重试）')
  assert.equal(saved.providers.trae.lastResult, '出错', 'B 的失败结果要留下，否则界面什么都看不到')
})

await test('各渠道独立记账：失败渠道在下一轮**单独**重试，成功渠道不再重跑', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['qodercn', 'trae'],
    failFor: ['trae'],
    doc: {
      ...emptyDoc(),
      providers: { qodercn: pdoc({ enabled: true }), trae: pdoc({ enabled: true }) },
    },
  })
  await engine.runIfDue()
  calls.length = 0
  await engine.runIfDue()
  assert.deepEqual(calls, ['trae'], `第二轮只该重试失败的那个，实际 ${JSON.stringify(calls)}`)
})

await test('各渠道独立记账：一个渠道 coversToday=0 不影响另一个记日期', async () => {
  // 旧模型下 `shouldMarkToday` 看的是整轮汇总，一个渠道的「非今日轮次」会让整轮不记账。
  const clock = fakeClock(utc8(2026, 10, 24, 10, 30))
  const store = memoryStore({
    ...emptyDoc(),
    providers: { qodercn: pdoc({ enabled: true }), trae: pdoc({ enabled: true }) },
  })
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => ['qodercn', 'trae'],
    claim: async provider => {
      // trae 声称「这条痕迹不是今天这一轮的」（例如 Qoder 在 10:00 刷新前看到的 CLAIMED）。
      const coversToday = provider === 'trae' ? 0 : 1
      return {
        ok: true,
        value: { summary: { ...TODAY_SUMMARY, totalByUnit: { ...TODAY_SUMMARY.totalByUnit }, coversToday } },
      }
    },
    now: () => clock.now,
    delayMs: 30_000,
    schedule: clock.schedule,
    scheduleInterval: clock.scheduleInterval,
  })
  await engine.runIfDue()
  const saved = store.read()
  assert.equal(saved.providers.qodercn.lastDate, '2026-10-24', 'qodercn（coversToday=1）应记今天')
  assert.equal(saved.providers.trae.lastDate, '', 'trae（coversToday=0）不得记今天')
})

await test('各渠道独立记账：state() 的 ranToday 逐渠道判定（互不牵连）', async () => {
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['qodercn', 'trae'],
    failFor: ['trae'],
    doc: {
      ...emptyDoc(),
      providers: { qodercn: pdoc({ enabled: true }), trae: pdoc({ enabled: true }) },
    },
  })
  await engine.runIfDue()
  assert.equal(providerState(engine, 'qodercn').ranToday, true)
  assert.equal(providerState(engine, 'trae').ranToday, false)
  assert.equal(store.read().providers.trae.lastDate, '')
})

await test('去重：某渠道 lastDate 已是今天 ⇒ 到点也不签它（另一个照签）', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: {
        qodercn: pdoc({ enabled: true, lastDate: '2026-10-24' }),
        trae: pdoc({ enabled: true }),
      },
    },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, ['trae'], `qodercn 今天已签，不该重跑；实际 ${JSON.stringify(calls)}`)
})

await test('去重：lastDate 是**昨天** ⇒ 今天照常签', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['qodercn'],
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, lastDate: '2026-10-23' }) } },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, ['qodercn'])
})

// === 7. setProviderEnabled / setProviderTime ==============================

await test('setProviderEnabled：只触发那一个渠道（开 A 不顺带签 B）', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: {
        // B 已开、也已到点、今天没签过 —— 若实现「开 A 时跑整轮」，B 一定会被签。
        trae: pdoc({ enabled: true, time: '10:05' }),
        qodercn: pdoc({ enabled: false, time: '10:05' }),
      },
    },
  })
  await engine.setProviderEnabled('qodercn', true)
  await drainMicrotasks()
  assert.deepEqual(calls, ['qodercn'], `只该签刚打开的 qodercn，实际 ${JSON.stringify(calls)}`)
})

await test('setProviderEnabled(true)：未到点不签（不能因为「刚打开」就提前打上游）', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: false, time: '10:05' }) } },
  })
  await engine.setProviderEnabled('qodercn', true)
  await drainMicrotasks()
  assert.deepEqual(calls, [], '08:00 打开 10:05 的开关不该当场签（否则 10:05 因 lastDate 已记而不再签）')
})

await test('setProviderEnabled(true)：已到点且今天没签 ⇒ 立刻签一次', async () => {
  const { engine, calls, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 11, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: false, time: '10:05' }) } },
  })
  await engine.setProviderEnabled('qodercn', true)
  await drainMicrotasks()
  assert.deepEqual(calls, ['qodercn'], '打开开关且已过点应立刻跑一轮')
  assert.equal(store.read().providers.qodercn.lastDate, '2026-10-24')
})

await test('setProviderEnabled(true)：今天已签过 ⇒ 打开开关不重签', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 11, 0),
    doc: {
      ...emptyDoc(),
      providers: { qodercn: pdoc({ enabled: false, time: '10:05', lastDate: '2026-10-24' }) },
    },
  })
  await engine.setProviderEnabled('qodercn', true)
  await drainMicrotasks()
  assert.deepEqual(calls, [], 'lastDate 是今天，不得重签')
})

await test('setProviderEnabled(true)：不支持签到的渠道被拒（返回 null）', async () => {
  for (const provider of ['cline', 'workbuddy', 'raccoon', 'zcode']) {
    const { engine, store } = createEngine({
      nowMs: utc8(2026, 10, 24, 10, 30),
      providers: [provider],
      doc: emptyDoc(),
    })
    const result = await engine.setProviderEnabled(provider, true)
    assert.equal(result, null, `对 ${provider} 写 enabled:true 必须被拒（静默接受等于允许用户开一个永不生效的开关）`)
    assert.equal(
      store.read().providers[provider], undefined,
      `${provider} 被拒后不得在文档里留下条目`,
    )
  }
})

await test('setProviderEnabled(false)：对不支持签到的渠道也允许（关掉无害）', async () => {
  for (const provider of ['cline', 'workbuddy', 'raccoon', 'zcode']) {
    const { engine, store } = createEngine({
      nowMs: utc8(2026, 10, 24, 10, 30),
      providers: [provider],
      doc: emptyDoc(),
    })
    const result = await engine.setProviderEnabled(provider, false)
    assert.notEqual(result, null, `对 ${provider} 写 enabled:false 应被允许`)
    assert.equal(store.read().providers[provider].enabled, false)
  }
})

await test('setProviderEnabled(false)：保留 time / lastDate / lastResult（关开关不是清数据）', async () => {
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    doc: {
      ...emptyDoc(),
      providers: {
        qodercn: pdoc({ enabled: true, time: '21:00', lastDate: '2026-10-23', lastResult: '1 个 +100积分', lastAt: 5 }),
      },
    },
  })
  await engine.setProviderEnabled('qodercn', false)
  assert.deepEqual(store.read().providers.qodercn, {
    enabled: false, time: '21:00', lastDate: '2026-10-23', lastResult: '1 个 +100积分', lastAt: 5,
  })
})

await test('落盘：setProviderEnabled 后 store 里能读到该渠道的开关（否则重启丢失）', async () => {
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    providers: ['trae'],
    doc: emptyDoc(),
  })
  await engine.setProviderEnabled('trae', true)
  assert.equal(store.read().providers.trae.enabled, true)
})

await test('落盘：setProviderTime 后 store 里能读到该渠道的时间（否则重启丢失）', async () => {
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    providers: ['trae'],
    doc: emptyDoc(),
  })
  await engine.setProviderTime('trae', '21:30')
  assert.equal(store.read().providers.trae.time, '21:30')
})

await test('setProviderTime：只改那一个渠道的时间，别的渠道不动', async () => {
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: { qodercn: pdoc({ enabled: true }), trae: pdoc({ enabled: true }) },
    },
  })
  await engine.setProviderTime('trae', '21:30')
  const saved = store.read()
  assert.equal(saved.providers.trae.time, '21:30')
  assert.equal(saved.providers.qodercn.time, '10:05', '改 trae 的时间不得顺带改 qodercn')
})

await test('setProviderTime：改到「已经过点」的时刻 ⇒ 立刻补签（不必等下一个周期）', async () => {
  const { engine, calls, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '23:00' }) } },
  })
  await engine.setProviderTime('qodercn', '10:05')
  await drainMicrotasks()
  assert.deepEqual(calls, ['qodercn'], '把时间改到已过点后应立刻补签，否则界面看起来像「改了没生效」')
  assert.equal(store.read().providers.qodercn.lastDate, '2026-10-24')
})

await test('setProviderTime：改到「还没到」的时刻 ⇒ 不签', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '10:05' }) } },
  })
  await engine.setProviderTime('qodercn', '22:00')
  await drainMicrotasks()
  assert.deepEqual(calls, [], '改到未来时刻后应继续等，不能因为「刚才已过旧时间」就签')
})

await test('setProviderTime：开关关着时改时间不签（关闭即彻底不动）', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: false, time: '23:00' }) } },
  })
  await engine.setProviderTime('qodercn', '00:01')
  await drainMicrotasks()
  assert.deepEqual(calls, [], '关闭状态下改时间不得触发签到')
})

await test('setProviderTime：不改 enabled（改时间不等于打开开关）', async () => {
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: false, time: '10:05' }) } },
  })
  await engine.setProviderTime('qodercn', '22:00')
  assert.equal(store.read().providers.qodercn.enabled, false)
})

// === 8. state()：逐渠道视图 + 兼容字段 ====================================

await test('state().providers 按 provider id 排序（稳定输出）', () => {
  const { engine } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    doc: {
      ...emptyDoc(),
      providers: { trae: pdoc(), codearts: pdoc(), qodercn: pdoc({ enabled: true }) },
    },
  })
  assert.deepEqual(
    engine.state().providers.map(entry => entry.provider),
    ['codearts', 'qodercn', 'trae'],
    'providers 必须按 id 排序，否则界面每轮刷新顺序都变',
  )
})

await test('state().providers 每项含 provider/enabled/time/ranToday/lastResult/lastAt/supported/running', () => {
  const { engine } = createEngine({
    nowMs: utc8(2026, 10, 24, 12, 0),
    doc: {
      ...emptyDoc(),
      providers: {
        qodercn: pdoc({ enabled: true, time: '09:00', lastDate: '2026-10-24', lastResult: 'A', lastAt: 100 }),
        cline: pdoc({ enabled: false }),
      },
    },
  })
  const state = engine.state()
  assert.deepEqual(state.providers.find(entry => entry.provider === 'qodercn'), {
    provider: 'qodercn',
    enabled: true,
    time: '09:00',
    lastDate: '2026-10-24',
    ranToday: true,
    lastResult: 'A',
    lastAt: 100,
    supported: true,
    running: false,
  })
  const cline = state.providers.find(entry => entry.provider === 'cline')
  assert.equal(cline.supported, false, 'cline 的 supported 必须是 false（界面据此置灰）')
})

await test('state() 兼容字段：enabled = 任一渠道开启；time = 第一个开启渠道的时间', () => {
  const { engine } = createEngine({
    nowMs: utc8(2026, 10, 24, 12, 0),
    doc: {
      ...emptyDoc(),
      providers: {
        codearts: pdoc({ enabled: false, time: '08:00' }),
        qodercn: pdoc({ enabled: true, time: '09:00' }),
        trae: pdoc({ enabled: true, time: '22:00' }),
      },
    },
  })
  const state = engine.state()
  assert.equal(state.enabled, true, '任一渠道开启 ⇒ enabled = true')
  // 排序后的第一个**开启**渠道是 qodercn（codearts 关闭，不算）。
  assert.equal(state.time, '09:00', `time 应取第一个开启渠道的时间，实际 ${state.time}`)
})

await test('state() 兼容字段：无任何渠道开启 ⇒ enabled=false、time=10:05', () => {
  const { engine } = createEngine({
    nowMs: utc8(2026, 10, 24, 12, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: false, time: '22:00' }) } },
  })
  const state = engine.state()
  assert.equal(state.enabled, false)
  assert.equal(state.time, '10:05', '无开启渠道时必须回落到默认值，而不是某个关闭渠道的时间')
})

await test('state() 兼容字段：空文档也是 enabled=false、time=10:05、providers=[]', () => {
  const { engine } = createEngine({ nowMs: utc8(2026, 10, 24, 12, 0), doc: emptyDoc() })
  const state = engine.state()
  assert.equal(state.enabled, false)
  assert.equal(state.time, '10:05')
  assert.deepEqual(state.providers, [])
  assert.equal(state.ranToday, false)
  assert.equal(state.running, false)
  assert.equal(state.lastDate, '')
  assert.equal(state.lastResult, '')
  assert.equal(state.lastAt, 0)
})

await test('state() 兼容字段：ranToday = 任一渠道今天跑过', () => {
  const { engine } = createEngine({
    nowMs: utc8(2026, 10, 24, 12, 0),
    doc: {
      ...emptyDoc(),
      providers: {
        qodercn: pdoc({ enabled: true, lastDate: '2026-10-23' }),
        trae: pdoc({ enabled: true, lastDate: '2026-10-24' }),
      },
    },
  })
  assert.equal(engine.state().ranToday, true, 'trae 今天跑过 ⇒ 顶层 ranToday = true')
})

await test('state() 兼容字段：lastResult / lastAt 取 lastAt 最大的那个渠道', () => {
  const { engine } = createEngine({
    nowMs: utc8(2026, 10, 24, 12, 0),
    doc: {
      ...emptyDoc(),
      providers: {
        qodercn: pdoc({ enabled: true, lastResult: 'A 结果', lastAt: 100 }),
        trae: pdoc({ enabled: true, lastResult: 'B 结果', lastAt: 200 }),
      },
    },
  })
  const state = engine.state()
  assert.equal(state.lastResult, 'B 结果', 'lastAt 更大的是 trae，顶层应回显它的结果')
})

// === 9. 兼容旧 UI 的全局方法 ==============================================

await test('setAllEnabled(true)：只影响支持签到的渠道，不给不支持的渠道建 enabled:true 记录', async () => {
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    providers: ['qodercn', 'cline', 'trae'],
    doc: emptyDoc(),
  })
  await engine.setAllEnabled(true)
  await drainMicrotasks()
  const saved = store.read()
  assert.equal(saved.providers.qodercn.enabled, true)
  assert.equal(saved.providers.trae.enabled, true)
  assert.equal(
    saved.providers.cline, undefined,
    `不得给不支持的渠道建 enabled:true 记录（界面会显示一个永不生效的开关），实际 ${JSON.stringify(saved.providers.cline)}`,
  )
})

await test('setAllEnabled(true)：全新安装（文档为空）也要生效 —— 范围取自账号池', async () => {
  // 只遍历 doc.providers 的实现在这里必然红：默认全关 ⇒ 文档是空的 ⇒ 什么都不发生。
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    providers: ['qodercn', 'trae'],
    doc: emptyDoc(),
  })
  await engine.setAllEnabled(true)
  await drainMicrotasks()
  const saved = store.read()
  assert.deepEqual(Object.keys(saved.providers).sort(), ['qodercn', 'trae'], '账号池里的渠道都要被开启')
})

await test('setAllEnabled(false)：全部关掉', async () => {
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: { qodercn: pdoc({ enabled: true }), trae: pdoc({ enabled: true }) },
    },
  })
  await engine.setAllEnabled(false)
  const saved = store.read()
  assert.equal(saved.providers.qodercn.enabled, false)
  assert.equal(saved.providers.trae.enabled, false)
})

await test('setAllEnabled(true)：已到点的渠道会被触发（不只写盘）', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['qodercn', 'trae'],
    doc: emptyDoc(),
  })
  await engine.setAllEnabled(true)
  await drainMicrotasks()
  assert.deepEqual(calls.sort(), ['qodercn', 'trae'], `已到点的渠道都该跑一轮，实际 ${JSON.stringify(calls)}`)
})

await test('setAllTimes：所有账号池渠道的时间都改成同一个值，且不改 enabled', async () => {
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: { qodercn: pdoc({ enabled: true, time: '09:00' }), trae: pdoc({ enabled: false, time: '09:00' }) },
    },
  })
  await engine.setAllTimes('21:30')
  await drainMicrotasks()
  const saved = store.read()
  assert.equal(saved.providers.qodercn.time, '21:30')
  assert.equal(saved.providers.trae.time, '21:30')
  assert.equal(saved.providers.qodercn.enabled, true, 'setAllTimes 不得改 enabled')
  assert.equal(saved.providers.trae.enabled, false, 'setAllTimes 不得改 enabled')
})

// === 10. 不支持签到的渠道在调度里被摘掉 ==================================

await test('调度：zcode 即便文档里 enabled=true 也不发任何 claim（排除表先于上游生效）', async () => {
  // ⚠️ 这是「脏文档 / 手工编辑」防线：zcode 的代价发生在**调用期间**（拉起浏览器
  // 产 captcha），事后判错误已经太晚，必须在调 claim 之前摘掉。
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['zcode'],
    doc: { ...emptyDoc(), providers: { zcode: pdoc({ enabled: true }) } },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, [], 'zcode 不得被自动签到调用')
})

await test('调度：cline 即便文档里 enabled=true 也不发任何 claim', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    providers: ['cline'],
    doc: { ...emptyDoc(), providers: { cline: pdoc({ enabled: true }) } },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, [], 'cline 没有签到接口，不该被调用')
})

// === 11. 到点才签 / 当天不重复 ===========================================

await test('调度：未到点不签（UTC+8 09:00，设定 10:05）', async () => {
  const { engine, calls } = createEngine({
    nowMs: utc8(2026, 10, 20, 9, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '10:05' }) } },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, [], '未到设定时间不应调用 claim')
})

await test('调度：到点后签（UTC+8 10:06，设定 10:05）', async () => {
  const { engine, calls, store } = createEngine({
    nowMs: utc8(2026, 10, 20, 10, 6),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '10:05' }) } },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, ['qodercn'], '到点后应签一轮')
  assert.equal(store.read().providers.qodercn.lastDate, '2026-10-20', 'lastDate 必须记为 UTC+8 当天')
})

await test('调度：全部渠道关闭 ⇒ runIfDue 不签、也不读账号池', async () => {
  let poolReads = 0
  const clock = fakeClock(utc8(2026, 10, 20, 10, 6))
  const store = memoryStore(emptyDoc())
  const recorder = claimRecorder(TODAY_SUMMARY)
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => { poolReads += 1; return ['qodercn'] },
    claim: recorder.claim,
    now: () => clock.now,
    delayMs: 30_000,
    schedule: clock.schedule,
    scheduleInterval: clock.scheduleInterval,
  })
  await engine.runIfDue()
  assert.deepEqual(recorder.calls, [], '全关状态下不应签')
  assert.equal(poolReads, 0, '没有任何渠道开启时不该读账号池（那是白白一次 IO）')
})

await test('调度：空账号池 ⇒ 不签、不记 lastDate（下次仍会重试）', async () => {
  const { engine, calls, store } = createEngine({
    nowMs: utc8(2026, 10, 20, 10, 6),
    providers: [],
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } },
  })
  await engine.runIfDue()
  assert.deepEqual(calls, [], '空池不应调用 claim')
  assert.equal(store.read().providers.qodercn.lastDate, '', '空池不应记 lastDate，否则当天再也不会重试')
})

await test('调度：读账号池抛错 ⇒ 打 warn 且不记 lastDate（下个周期重试）', async () => {
  const clock = fakeClock(utc8(2026, 10, 20, 10, 6))
  const store = memoryStore({ ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } })
  const warnings = []
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => { throw new Error('池炸了') },
    claim: async () => ({ ok: true, value: { summary: { ...TODAY_SUMMARY } } }),
    now: () => clock.now,
    delayMs: 30_000,
    schedule: clock.schedule,
    scheduleInterval: clock.scheduleInterval,
    warn: message => warnings.push(message),
  })
  await engine.runIfDue()
  assert.equal(store.read().providers.qodercn.lastDate, '')
  assert.ok(
    warnings.some(message => message.includes('读取账号池失败')),
    `读池失败必须打 warn，实际 warnings=${JSON.stringify(warnings)}`,
  )
})

await test('调度：claim 抛异常 ⇒ 记「出错」但不记 lastDate（下轮重试）', async () => {
  const clock = fakeClock(utc8(2026, 10, 20, 10, 6))
  const store = memoryStore({ ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } })
  const warnings = []
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => ['qodercn'],
    claim: async () => { throw new Error('boom') },
    now: () => clock.now,
    delayMs: 30_000,
    schedule: clock.schedule,
    scheduleInterval: clock.scheduleInterval,
    warn: message => warnings.push(message),
  })
  await engine.runIfDue()
  const saved = store.read()
  assert.equal(saved.providers.qodercn.lastDate, '', '抛异常不得记今天')
  assert.equal(saved.providers.qodercn.lastResult, '出错')
  assert.ok(warnings.some(message => message.includes('调用异常')), '异常必须打 warn')
})

await test('记账：coversToday 为 0 时不记日期（下一轮会重试）', async () => {
  const { engine, calls, store } = createEngine({
    nowMs: utc8(2026, 10, 20, 10, 6),
    summary: { ...TODAY_SUMMARY, coversToday: 0 },
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } },
  })
  await engine.runIfDue()
  assert.equal(calls.length, 1, '这一轮仍然要跑')
  assert.equal(store.read().providers.qodercn.lastDate, '', 'coversToday=0 说明没证明「今天已处理」，不得记日期')

  await engine.runIfDue()
  assert.equal(calls.length, 2, '没记日期时下一次必须重试')
})

// === 12. 跨天重触发（核心回归）===========================================

await test('核心回归：跨天重新触发（同一实例、不重建、某渠道连续两天都签）', async () => {
  const { engine, clock, calls, store } = createEngine({
    nowMs: utc8(2026, 10, 20, 10, 6),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '10:05' }) } },
  })
  await engine.runIfDue()
  assert.equal(calls.length, 1, '第 1 天到点应签一次')
  assert.equal(store.read().providers.qodercn.lastDate, '2026-10-20')

  await engine.runIfDue()
  assert.equal(calls.length, 1, '同一天第二次不应重复')

  clock.setNow(utc8(2026, 10, 21, 9, 0))
  await engine.runIfDue()
  assert.equal(calls.length, 1, '第 2 天尚未到点不应签')

  clock.setNow(utc8(2026, 10, 21, 10, 6))
  await engine.runIfDue()
  assert.equal(calls.length, 2, '第 2 天到点必须再次触发 —— 这是本功能的核心验收点')
  assert.equal(store.read().providers.qodercn.lastDate, '2026-10-21', 'lastDate 必须前进到第 2 天')
})

await test('定时器：常驻进程跨天自动签到（不重启、只推进时钟）', async () => {
  const { engine, clock, calls, store } = createEngine({
    nowMs: utc8(2026, 10, 20, 8, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '10:05' }) } },
  })
  engine.start()
  try {
    // 第 1 天：08:00 起步，推进 24 小时 ⇒ 应在 10:05 之后签一次。
    await drive(clock, DAY_MS)
    assert.equal(calls.length, 1, '第 1 天应恰好签一次（旧实现只在启动时签，这条会红）')
    assert.equal(store.read().providers.qodercn.lastDate, '2026-10-20')

    // 第 2 天：同一实例继续常驻 ⇒ 必须再签一次。这是用户报障的原缺口。
    await drive(clock, DAY_MS)
    assert.equal(calls.length, 2, '第 2 天到点必须再次触发：进程常驻不重启也要签')
    assert.equal(store.read().providers.qodercn.lastDate, '2026-10-21')

    // 第 3 天：再确认一次，避免「只补一天」的实现蒙对。
    await drive(clock, DAY_MS)
    assert.equal(calls.length, 3, '第 3 天同样要触发')
    assert.equal(store.read().providers.qodercn.lastDate, '2026-10-22')
  } finally {
    engine.stop()
  }
})

await test('定时器：一天之内只签一次（不会每 5 分钟重复）', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 20, 10, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '10:05' }) } },
  })
  engine.start()
  try {
    await drive(clock, 13 * 3_600_000) // 10:00 → 23:00，跨过 10:05 且含大量周期检查
    assert.equal(calls.length, 1, '当天只应签一次')
  } finally {
    engine.stop()
  }
})

await test('定时器：常驻 10 天，每天恰好签一次', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 20, 8, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '10:05' }) } },
  })
  engine.start()
  try {
    await drive(clock, 10 * DAY_MS)
    assert.equal(calls.length, 10, `期望 10 次，实际 ${calls.length} 次`)
  } finally {
    engine.stop()
  }
})

await test('定时器：到点时进程未启动 → 启动后立刻补签', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 20, 14, 0), // 下午才开机
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '10:05' }) } },
  })
  engine.start()
  try {
    await drive(clock, 10 * 60_000) // 给足首轮延迟（默认 30 秒）
    assert.equal(calls.length, 1, '启动时已过今天的设定时间，应立刻补签')
  } finally {
    engine.stop()
  }
})

await test('定时器：逐渠道独立时间，一天之内各按自己的时间签', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 8, 0),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: {
        qodercn: pdoc({ enabled: true, time: '09:00' }),
        trae: pdoc({ enabled: true, time: '22:00' }),
      },
    },
  })
  engine.start()
  try {
    await drive(clock, DAY_MS)
    assert.deepEqual(calls, ['qodercn', 'trae'], `各自到点各签一次，实际 ${JSON.stringify(calls)}`)
    assert.equal(src.utc8DateString(clock.now), '2026-10-25', '推进一天后应落在次日（日期算术自检）')
  } finally {
    engine.stop()
  }
})

await test('定时器：全部渠道关闭 ⇒ 常驻一整天也不签', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 20, 8, 0),
    doc: emptyDoc(),
  })
  engine.start()
  try {
    await drive(clock, DAY_MS)
    assert.deepEqual(calls, [], '全关状态下常驻一整天不得签')
  } finally {
    engine.stop()
  }
})

await test('定时器：stop() 之后不再触发', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 20, 8, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } },
  })
  engine.start()
  engine.stop()
  await drive(clock, DAY_MS)
  assert.deepEqual(calls, [], 'stop() 后不应再有任何自动签到')
})

await test('关闭：stop() 会拆掉周期检查（插件卸载后不得再醒来）', async () => {
  const { engine, clock } = createEngine({
    nowMs: utc8(2026, 10, 20, 8, 0),
    doc: emptyDoc(),
  })
  engine.start()
  await drive(clock, 60_000) // 让首次检查到期，从而建立起周期检查
  assert.ok(clock.intervals().length > 0, '首次检查之后应当建立起周期检查（否则跨天回归无从谈起）')
  engine.stop()
  assert.equal(clock.liveIntervals().length, 0, 'stop() 必须取消周期检查：unref() 只是不拖住退出，不代表不再触发')
})

await test('start() 幂等：连续调用两次不排出两条周期检查', async () => {
  const { engine, clock } = createEngine({
    nowMs: utc8(2026, 10, 20, 8, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } },
  })
  engine.start()
  engine.start()
  engine.start()
  try {
    // 首次检查还没到期时，三次调用只该有**一个**待执行的一次性定时器。
    assert.equal(clock.pending().length, 1, '重复 start() 不得排出多个首次检查定时器')
    await drive(clock, 60_000) // 让首次检查到期 ⇒ 建立周期检查
    assert.equal(clock.liveIntervals().length, 1, `重复 start() 不得排出多条周期检查（实际 ${clock.liveIntervals().length} 条）`)
  } finally {
    engine.stop()
  }
})

await test('start() 幂等：重复调用不会让一天签两次', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 20, 8, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } },
  })
  engine.start()
  engine.start()
  try {
    await drive(clock, DAY_MS)
    assert.equal(calls.length, 1, '重复 start() 后当天仍只该签一次（排了两条 ticker 会变成并发两轮）')
  } finally {
    engine.stop()
  }
})

await test('stop() 后重新 start()：调度恢复并补签', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 20, 9, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '10:05' }) } },
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

await test('tickMs 注入：压到 1 分钟后，过点即签（不必等满 5 分钟）', async () => {
  const clock = fakeClock(utc8(2026, 10, 20, 10, 0))
  const store = memoryStore({ ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '10:05' }) } })
  const recorder = claimRecorder(TODAY_SUMMARY)
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => ['qodercn'],
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
    const live = clock.liveIntervals()
    assert.equal(live.length, 1, '应当只有一条周期检查')
    assert.equal(live[0].ms, 60_000, `周期检查的间隔应等于注入的 tickMs，实际 ${live[0].ms}`)
  } finally {
    engine.stop()
  }
})

await test('inflight 去重：并发 runIfDue 只跑一轮', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const clock = fakeClock(utc8(2026, 10, 20, 10, 6))
  const store = memoryStore({ ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } })
  const calls = []
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => ['qodercn'],
    claim: async provider => {
      calls.push(provider)
      await gate
      return { ok: true, value: { summary: { ...TODAY_SUMMARY, totalByUnit: { ...TODAY_SUMMARY.totalByUnit } } } }
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

await test('inflight 按渠道去重：A 在跑时打开 B，B 仍能跑（不该被 A 挡住）', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const clock = fakeClock(utc8(2026, 10, 20, 10, 6))
  const store = memoryStore({
    ...emptyDoc(),
    providers: { qodercn: pdoc({ enabled: true }), trae: pdoc({ enabled: true }) },
  })
  const calls = []
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => ['qodercn', 'trae'],
    claim: async provider => {
      calls.push(provider)
      if (provider === 'qodercn') await gate
      return { ok: true, value: { summary: { ...TODAY_SUMMARY, totalByUnit: { ...TODAY_SUMMARY.totalByUnit } } } }
    },
    now: () => clock.now,
    delayMs: 30_000,
    schedule: clock.schedule,
    scheduleInterval: clock.scheduleInterval,
  })
  const first = engine.runIfDue(['qodercn'])
  await drainMicrotasks()
  const second = engine.runIfDue(['trae'])
  await drainMicrotasks()
  release()
  await Promise.all([first, second])
  assert.deepEqual(calls, ['qodercn', 'trae'], `B 不该因为 A 在跑而被挡掉，实际 ${JSON.stringify(calls)}`)
})

await test('state().running：渠道执行期间为 true，跑完回到 false', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const clock = fakeClock(utc8(2026, 10, 20, 10, 6))
  const store = memoryStore({ ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } })
  const engine = src.createAutoCheckin({
    store,
    listProviderIds: async () => ['qodercn'],
    claim: async () => {
      await gate
      return { ok: true, value: { summary: { ...TODAY_SUMMARY, totalByUnit: { ...TODAY_SUMMARY.totalByUnit } } } }
    },
    now: () => clock.now,
    delayMs: 30_000,
    schedule: clock.schedule,
    scheduleInterval: clock.scheduleInterval,
  })
  const running = engine.runIfDue()
  await drainMicrotasks()
  assert.equal(engine.state().running, true, '执行期间顶层 running 应为 true（界面据此显示「进行中」）')
  assert.equal(providerState(engine, 'qodercn').running, true, '逐渠道 running 也应为 true')
  release()
  await running
  assert.equal(engine.state().running, false)
  assert.equal(providerState(engine, 'qodercn').running, false)
})

// === 13. 时钟异常 ========================================================

await test('时钟回拨（NTP 校正）：lastDate 已是今天 → 不得重签', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 20, 10, 6),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } },
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
    nowMs: utc8(2026, 10, 20, 8, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true }) } },
  })
  engine.start()
  try {
    clock.setNow(utc8(2026, 10, 25, 11, 0)) // 直接跳到 5 天后
    await drive(clock, 5 * 60_000)
    assert.equal(calls.length, 1, '前跳后应只签一次（不补签中间错过的日期）')
    assert.equal(store.read().providers.qodercn.lastDate, '2026-10-25')
  } finally {
    engine.stop()
  }
})

// === 14. 日末盲区（已修复，2026-10-23 转正式回归）=========================

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
 * | 条件 | 结果 | 含义 |
 * |---|---|---|
 * | `minutes >= target` | `{ due: true, reason: 'reached' }` | 常规路径，已到点 |
 * | `minutes + tickMinutes >= 1440` | `{ due: true, reason: 'last-chance' }` | **下一次检查已不在今天**，再等就永远等不到 ⇒ 本轮放行 |
 * | 其它 | `{ due: false, reason: 'waiting' }` | 继续等 |
 *
 * ## ⚠️ 代价：`last-chance` 是**提前签**，不是准时签
 *
 * 设定 23:59 时，若最后一次 tick 在 23:55，`1435 + 5 >= 1440` 成立 ⇒ **23:55 就签**，
 * 比用户设定的时刻早 4 分钟。实测提前量 0–4 分钟，恒 ≤ 一个 `tickMs`。
 */
await test('日末盲区（已修复）：设定 23:59 常驻三天应签三次', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 20, 0, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '23:59' }) } },
  })
  engine.start()
  try {
    await drive(clock, 3 * DAY_MS)
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
      nowMs: utc8(2026, 10, 20, 0, startMinute),
      doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '23:59' }) } },
    })
    engine.start()
    try {
      await drive(clock, 3 * DAY_MS)
      if (calls.length !== 3) missing.push({ startMinute, count: calls.length })
    } finally {
      engine.stop()
    }
  }
  assert.deepEqual(missing, [], `这些启动相位下未签满 3 次：${JSON.stringify(missing)}`)
})

await test('日末盲区：逐渠道独立生效（A 设 23:59、B 设 10:05，两天都各签两次）', async () => {
  const { engine, clock, calls } = createEngine({
    nowMs: utc8(2026, 10, 24, 0, 1),
    providers: ['qodercn', 'trae'],
    doc: {
      ...emptyDoc(),
      providers: {
        qodercn: pdoc({ enabled: true, time: '23:59' }),
        trae: pdoc({ enabled: true, time: '10:05' }),
      },
    },
  })
  engine.start()
  try {
    await drive(clock, 2 * DAY_MS)
    const byProvider = calls.reduce((acc, provider) => {
      acc[provider] = (acc[provider] ?? 0) + 1
      return acc
    }, {})
    assert.deepEqual(byProvider, { qodercn: 2, trae: 2 }, `两天两渠道应各签两次，实际 ${JSON.stringify(byProvider)}`)
  } finally {
    engine.stop()
  }
})

await test('提前量：设定 23:59 时实际签到时刻的提前量恒 ≤ 一个 tick', async () => {
  // `last-chance` 是提前签。要守住的是「提前量有界」：绝不能提前半小时，
  // 否则用户设 23:59 却在 23:30 被打上游，那就不是补偿而是失控。
  const tickMs = 5 * 60_000
  const tickMinutes = tickMs / 60_000
  const target = 23 * 60 + 59
  for (let startMinute = 0; startMinute < 60; startMinute += 1) {
    const { engine, clock, calls } = createEngine({
      nowMs: utc8(2026, 10, 20, 0, startMinute),
      doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '23:59' }) } },
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
    assert.ok(
      lead >= 0,
      `启动相位 00:${startMinute} 在设定时刻**之后**才签（提前量 ${lead}），不符合 last-chance 语义`,
    )
    assert.ok(
      lead <= tickMinutes,
      `启动相位 00:${startMinute} 提前 ${lead} 分钟签，超过一个 tick（${tickMinutes} 分钟）—— 提前量失控`,
    )
  }
})

await test('isCheckinDue：last-chance 只在日末窗口触发，白天零误触发', () => {
  const tickMs = 5 * 60_000
  const windowStart = 1440 - tickMs / 60_000
  // 全 time × 全分钟扫描：last-chance 只允许出现在「离午夜不足一个 tick」时。
  const offenders = []
  for (let target = 0; target < 1440; target += 1) {
    const time = `${String(Math.floor(target / 60)).padStart(2, '0')}:${String(target % 60).padStart(2, '0')}`
    for (let minute = 0; minute < 1440; minute += 1) {
      const decision = src.isCheckinDue(time, utc8(2026, 10, 20, 0, minute), tickMs)
      if (decision.due && decision.reason === 'last-chance' && minute < windowStart) {
        offenders.push({ time, minute })
      }
    }
  }
  assert.deepEqual(offenders.slice(0, 5), [], 'last-chance 在白天误触发（应只在日末窗口）')
})

await test('isCheckinDue：每个合法 time 在当天都至少有一个可签时刻', () => {
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

await test('isCheckinDue：非法 time 一律 waiting（不声称最后机会）', () => {
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
    nowMs: utc8(2026, 10, 20, 0, 0),
    doc: { ...emptyDoc(), providers: { qodercn: pdoc({ enabled: true, time: '23:50' }) } },
  })
  engine.start()
  try {
    await drive(clock, 3 * DAY_MS)
    assert.equal(calls.length, 3, '23:50 在安全区内，每天应各签一次')
  } finally {
    engine.stop()
  }
})

// === 15. dismiss：常驻状态文字的关闭标记 ==================================

await test('dismiss：记的是**这一轮**的 lastAt，不是布尔', async () => {
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 12, 0),
    doc: { ...emptyDoc(), lastAt: 500 },
  })
  assert.equal(engine.state().dismissed, false, '未关闭过时 dismissed 应为 false')
  const state = await engine.dismiss()
  assert.equal(state.dismissed, true)
  assert.equal(store.read().dismissedRunAt, 500, 'dismissedRunAt 必须记下当时的 lastAt')
})

await test('dismiss：新一轮跑完 lastAt 变了 ⇒ 状态文字重新出现', async () => {
  // 否则用户关过一次以后就再也看不到新的结果。
  const { engine, store } = createEngine({
    nowMs: utc8(2026, 10, 24, 10, 30),
    doc: {
      ...emptyDoc(),
      lastAt: 500,
      dismissedRunAt: 500,
      providers: { qodercn: pdoc({ enabled: true }) },
    },
  })
  assert.equal(engine.state().dismissed, true, '预置状态：已关闭')
  await engine.runIfDue()
  assert.equal(store.read().dismissedRunAt, 0, '新一轮跑完必须清掉旧的「已关闭」标记')
  assert.equal(engine.state().dismissed, false, '新一轮结果应重新出现')
})

// === 16. 跨端契约：客户端与服务端的时间判据必须一致 ======================

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

// === 17. RPC 层：provider 参数与严格校验 =================================

/**
 * 挂载真实的 `channel-pack-rpc.ts`，只取 `usage.autoCheckin` 一条路径。
 *
 * ⚠️ 必须走真实 RPC：`time` 的**严格**校验只在写入路径上，`sanitizeAutoCheckin`
 * 那条是**宽松回落**（面对磁盘脏数据）。两处判据若不一致，表现就是
 * 「UI 能存、调度不生效」—— 本组用例正是守这一点。
 *
 * 账号池是**空池**桩：即使真跑一轮也不会发任何上游请求。
 */
async function mountRpc() {
  const rpcUrl = await bundleSource('channel-pack-rpc.ts', 'channel-pack-rpc.mjs')
  const rpc = await import(rpcUrl)
  const routes = []
  const services = { connection: { fetch: { register: route => routes.push(route) } } }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
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
  const pool = new Proxy({}, {
    get: (_target, key) => {
      if (key === 'listAllAccounts') return async () => []
      if (key === 'listAccountsByProvider') return () => []
      if (key === 'listAccounts') return async () => []
      return async () => undefined
    },
  })
  const auth = new Proxy({}, { get: () => async () => undefined })
  rpc.registerChannelPackRpc(
    ctx, pool,
    auth, auth, auth, auth, auth, auth, auth,
    auth, auth, auth, auth, auth, auth, auth, auth, auth,
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
  console.log('FAIL 挂载 channel-pack-rpc.ts')
  console.log(`       ${String(error?.message ?? error).split('\n').join('\n       ')}`)
  results.push({ name: '挂载 channel-pack-rpc.ts', kind: 'fail', error })
}

if (rpcCall !== null) {
  /** 读某个渠道在 RPC 回显里的那一项。 */
  const rpcProvider = (result, provider) =>
    result.value?.autoCheckin?.providers?.find(entry => entry.provider === provider)

  await test('RPC：无参查询回显 enabled=false、time=10:05、providers=[]', async () => {
    const result = await rpcCall('usage.autoCheckin', {})
    assert.equal(result.ok, true, `查询应成功：${JSON.stringify(result.error)}`)
    assert.equal(result.value.autoCheckin.enabled, false, 'RPC 回显的开关默认必须是关闭')
    assert.equal(result.value.autoCheckin.time, '10:05', 'RPC 回显的时间默认必须是 10:05')
    assert.deepEqual(result.value.autoCheckin.providers, [], '默认没有任何渠道条目')
  })

  await test('RPC：{provider,enabled:true} 只改那一个渠道', async () => {
    const result = await rpcCall('usage.autoCheckin', { provider: 'qodercn', enabled: true })
    assert.equal(result.ok, true, `应成功：${JSON.stringify(result.error)}`)
    assert.equal(rpcProvider(result, 'qodercn')?.enabled, true)
    // 别的渠道不得被顺带开启（旧全局 fan-out 的语义已被 provider 参数取代）。
    assert.equal(rpcProvider(result, 'trae'), undefined, '不该凭空给别的渠道建条目')
  })

  await test('RPC：{provider,time} 只改那一个渠道的时间', async () => {
    const result = await rpcCall('usage.autoCheckin', { provider: 'trae', time: '22:00' })
    assert.equal(result.ok, true, `应成功：${JSON.stringify(result.error)}`)
    assert.equal(rpcProvider(result, 'trae')?.time, '22:00')
    assert.equal(rpcProvider(result, 'qodercn')?.time, '10:05', 'qodercn 的时间不得被顺带改掉')
  })

  await test('RPC：{provider,time,enabled} 同给时先写时间再写开关', async () => {
    // ⚠️ 顺序有实际后果：`setProviderEnabled(true)` 会**立刻**按当前 `time` 判一轮。
    // 若先写开关后写时间，用户把 10:05 改成 22:00 并同时打开开关时，会按**旧**
    // 时间（已过点）当场签一次，然后 22:00 因 `lastDate` 已记而不再签 —— 用户
    // 设的时间等于没生效。故这里断言「开开关那一刻看到的是新时间」。
    const result = await rpcCall('usage.autoCheckin', { provider: 'codearts', time: '22:00', enabled: true })
    assert.equal(result.ok, true, `同时写入应成功：${JSON.stringify(result.error)}`)
    assert.equal(rpcProvider(result, 'codearts')?.time, '22:00', '回显的时间必须是新时间')
    assert.equal(rpcProvider(result, 'codearts')?.enabled, true)
  })

  for (const provider of ['cline', 'workbuddy', 'raccoon']) {
    await test(`RPC：{provider:${provider},enabled:true} → bad-request（无签到接口）`, async () => {
      const result = await rpcCall('usage.autoCheckin', { provider, enabled: true })
      assert.equal(result.ok, false, `${provider} 不支持签到，写 enabled:true 必须被拒`)
      assert.equal(result.error?.code, 'bad-request')
    })
  }

  await test('RPC：{provider:zcode,enabled:true} → bad-request（签到代价高）', async () => {
    const result = await rpcCall('usage.autoCheckin', { provider: 'zcode', enabled: true })
    assert.equal(result.ok, false, 'zcode 有签到但代价高，自动签到必须被拒')
    assert.equal(result.error?.code, 'bad-request')
  })

  await test('RPC：{provider:cline,enabled:false} 允许（关掉不支持的渠道无害）', async () => {
    const result = await rpcCall('usage.autoCheckin', { provider: 'cline', enabled: false })
    assert.equal(result.ok, true, `应允许：${JSON.stringify(result.error)}`)
    assert.equal(rpcProvider(result, 'cline')?.enabled, false)
  })

  await test('RPC：{provider} 非字符串 / 空串 → bad-request', async () => {
    for (const bad of ['', 123, null, [], {}]) {
      const result = await rpcCall('usage.autoCheckin', { provider: bad, enabled: true })
      assert.equal(result.ok, false, `provider=${JSON.stringify(bad)} 应被拒绝`)
      assert.equal(result.error?.code, 'bad-request')
    }
  })

  for (const bad of ['9:05', '25:00', '10:05:00', ' 10:05']) {
    await test(`RPC：{provider,time:${JSON.stringify(bad)}} → bad-request`, async () => {
      const result = await rpcCall('usage.autoCheckin', { provider: 'qodercn', time: bad })
      assert.equal(result.ok, false, '非法值必须被拒绝（收到 ok=true）')
      assert.equal(result.error?.code, 'bad-request', `错误码应为 bad-request，实际 ${JSON.stringify(result.error?.code)}`)
    })
  }

  await test('RPC：合法 time "10:05" 通过', async () => {
    const result = await rpcCall('usage.autoCheckin', { provider: 'qodercn', time: '10:05' })
    assert.equal(result.ok, true, `合法值应被接受：${JSON.stringify(result.error)}`)
    assert.equal(rpcProvider(result, 'qodercn')?.time, '10:05')
  })

  await test('RPC：非法 time 不污染已存的值', async () => {
    const before = await rpcCall('usage.autoCheckin', {})
    const beforeTime = rpcProvider(before, 'qodercn')?.time
    await rpcCall('usage.autoCheckin', { provider: 'qodercn', time: '9:05' })
    const after = await rpcCall('usage.autoCheckin', {})
    assert.equal(rpcProvider(after, 'qodercn')?.time, beforeTime, '被拒绝的写入不应改变已有时间')
  })

  await test('RPC：{enabled} 非布尔值 → bad-request', async () => {
    for (const bad of ['true', 1, null]) {
      const result = await rpcCall('usage.autoCheckin', { provider: 'qodercn', enabled: bad })
      assert.equal(result.ok, false, `enabled=${JSON.stringify(bad)} 应被拒绝`)
      assert.equal(result.error?.code, 'bad-request')
    }
  })

  await test('RPC：省略 provider 走全局 fan-out（兼容旧 UI），只影响账号池里的渠道', async () => {
    // ⚠️ 这是过渡期路径，`client.js` 那版全局开关还在用。判据是「范围 = 账号池」：
    // 本挂载的账号池是**空**的 ⇒ 一条新条目都不该被建出来（也不能报错）。
    // ⚠️ 不能断言 `enabled === false`：前面几条用例已经在这个共享文档里开了渠道，
    // 那与本次调用无关 —— 那会变成「依赖用例执行顺序」的假断言。
    const before = await rpcCall('usage.autoCheckin', {})
    const beforeIds = before.value.autoCheckin.providers.map(entry => entry.provider)
    const result = await rpcCall('usage.autoCheckin', { enabled: true })
    assert.equal(result.ok, true, `旧 UI 的全局调用必须仍被接受：${JSON.stringify(result.error)}`)
    assert.deepEqual(
      result.value.autoCheckin.providers.map(entry => entry.provider), beforeIds,
      '空账号池 ⇒ 全局 fan-out 不该建出任何新渠道条目',
    )
  })

  await test('RPC：{provider} 省略时 time 也走全局 fan-out（不报错）', async () => {
    const result = await rpcCall('usage.autoCheckin', { time: '21:00' })
    assert.equal(result.ok, true, `应成功：${JSON.stringify(result.error)}`)
  })

  await test('RPC：写入后落盘 —— 重新查询能读到该渠道的新值', async () => {
    await rpcCall('usage.autoCheckin', { provider: 'trae', time: '20:15', enabled: true })
    const reread = await rpcCall('usage.autoCheckin', {})
    assert.equal(rpcProvider(reread, 'trae')?.time, '20:15')
    assert.equal(rpcProvider(reread, 'trae')?.enabled, true)
  })

  await test('RPC：旧全局文档迁移后 providers 为空、enabled=false（不把旧 true 展开）', async () => {
    // 直接往 store 的位置写一份旧格式文档，再让一个新的 RPC 挂载读它。
    const legacyHome = path.join(scratch, 'legacy-home')
    fs.mkdirSync(path.join(legacyHome, 'channel-pack'), { recursive: true })
    fs.writeFileSync(
      path.join(legacyHome, 'channel-pack', 'auto-checkin.json'),
      JSON.stringify({ schema: 'dsh-codearts-auth/auto-checkin/v1', enabled: true, time: '22:30', lastDate: '2026-10-20', lastAt: 123 }),
      'utf-8',
    )
    const previous = process.env.DSH_CHANNEL_PACK_STATE_DIR
    process.env.DSH_CHANNEL_PACK_STATE_DIR = legacyHome
    try {
      const { call } = await mountRpc()
      const result = await call('usage.autoCheckin', {})
      assert.equal(result.ok, true, `查询应成功：${JSON.stringify(result.error)}`)
      assert.deepEqual(result.value.autoCheckin.providers, [], '旧 enabled:true 不得展开到任何渠道')
      assert.equal(result.value.autoCheckin.enabled, false, '迁移后必须是全关')
    } finally {
      if (previous === undefined) delete process.env.DSH_CHANNEL_PACK_STATE_DIR
      else process.env.DSH_CHANNEL_PACK_STATE_DIR = previous
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
//   显式说明「这是 XPASS 不是断言失败」，且绝不能打印 `undefined`。

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
