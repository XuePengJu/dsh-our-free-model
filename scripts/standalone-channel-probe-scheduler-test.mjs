/**
 * 渠道探测的调度语义：按渠道分组、组内限流、跨渠道并行、总并发封顶。
 *
 * 为什么单独锁这条：`probeChannelModels` 的耗时几乎全由调度决定。旧实现是
 * 全局并发 2 的单池（33 行实测 57.6 s，其中一条 45 s 超时行独占一个通道），
 * 改成「同渠道 2 条 / 跨渠道并行 / 总并发 8 / 单条 20 s」后同一批数据约 20 s。
 * 但并发一旦调错方向，代价不是慢而是**误判**——同一个账号被并发打满会换回
 * 429，模型被标成「限流中」。所以这里用假的 channels 把四条不变量钉住：
 *
 * 1. 同一渠道在飞不超过 `perChannel`；
 * 2. 不同渠道确实并行（总峰值 > 单渠道上限），否则并发没生效；
 * 3. 总在飞不超过 `concurrency`；
 * 4. 一条卡死的模型只耗自己的 `timeoutMs`，不挡住别的渠道、更不挡住同渠道
 *    的另一条（组内 2 个名额，不是串行）。
 *
 * Run: node scripts/standalone-channel-probe-scheduler-test.mjs
 */
import assert from 'node:assert/strict'
import { probeChannelModels } from '../packages/standalone/channel-probe.mjs'

let checks = 0
let failures = 0
const check = async (name, body) => {
  checks++
  try { await body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`) }
}

/**
 * 假的渠道运行时：按模型 id 决定这条 ping 多久返回。
 *
 * `Infinity` 表示永不返回，只能被探测自己的超时中断 —— 用来模拟线上那条
 * 45 s 都吐不出首帧的模型。
 */
function fakeChannels(delayOf) {
  const inFlight = new Map()
  const peak = new Map()
  const order = []
  let global = 0
  let globalPeak = 0
  const settle = channel => {
    inFlight.set(channel, inFlight.get(channel) - 1)
    global--
  }
  const channels = {
    complete: request => new Promise((resolve, reject) => {
      const channel = request.model.slice(0, request.model.indexOf('/'))
      inFlight.set(channel, (inFlight.get(channel) ?? 0) + 1)
      peak.set(channel, Math.max(peak.get(channel) ?? 0, inFlight.get(channel)))
      global++
      globalPeak = Math.max(globalPeak, global)
      const delay = delayOf(request.model)
      const timer = delay === Infinity ? undefined : setTimeout(() => {
        settle(channel)
        order.push(request.model)
        resolve({ text: 'ok' })
      }, delay)
      request.signal?.addEventListener('abort', () => {
        if (timer !== undefined) clearTimeout(timer)
        settle(channel)
        order.push(request.model)
        reject(request.signal.reason ?? new Error('aborted'))
      }, { once: true })
    }),
  }
  return { channels, peak, order, globalPeak: () => globalPeak }
}

const rowsOf = (...counts) => counts.flatMap(([channel, count]) =>
  Array.from({ length: count }, (_, index) => ({ id: `${channel}/m${index}` })))

await check('同渠道最多 perChannel 条在飞，跨渠道并行（总峰值高于单渠道上限）', async () => {
  const fake = fakeChannels(() => 20)
  const rows = rowsOf(['alpha', 6], ['beta', 4], ['gamma', 1])
  const results = await probeChannelModels(fake.channels, rows, { perChannel: 2, concurrency: 8, timeoutMs: 1000 })
  assert.equal(Object.keys(results).length, 11, '每一行都要有判定')
  for (const [channel, value] of fake.peak) assert.ok(value <= 2, `${channel} 峰值 ${value} 超过组内上限 2`)
  assert.equal(fake.peak.get('alpha'), 2, 'alpha 有 6 行，应当真的跑满 2 个名额')
  assert.ok(fake.globalPeak() > 2, `总峰值 ${fake.globalPeak()} 说明渠道之间没有并行`)
  assert.ok(fake.globalPeak() <= 8, `总峰值 ${fake.globalPeak()} 超过总并发上限 8`)
})

await check('总并发封顶：两个渠道各 6 行、上限 3 时，总峰值就是 3', async () => {
  const fake = fakeChannels(() => 20)
  const results = await probeChannelModels(fake.channels, rowsOf(['alpha', 6], ['beta', 6]), {
    perChannel: 2, concurrency: 3, timeoutMs: 1000,
  })
  assert.equal(Object.keys(results).length, 12)
  assert.equal(fake.globalPeak(), 3, '全局名额应当被用满但不越过上限')
  for (const [channel, value] of fake.peak) assert.ok(value <= 2, `${channel} 峰值 ${value} 超过组内上限 2`)
})

await check('卡死的模型只耗自己的超时：不挡别的渠道，也不挡同渠道的另一条', async () => {
  const fake = fakeChannels(model => model === 'alpha/hang' ? Infinity : 20)
  const rows = [{ id: 'alpha/hang' }, { id: 'alpha/fast' }, { id: 'beta/x' }, { id: 'gamma/y' }]
  // 探测自己的超时定时器是 unref 的（线上有 HTTP server 撑着事件循环），这里
  // 必须自己保活，否则进程会在超时触发前就退出，await 永远不落地。
  const keepAlive = setTimeout(() => {}, 2000)
  const started = Date.now()
  let results
  try {
    results = await probeChannelModels(fake.channels, rows, { perChannel: 2, concurrency: 8, timeoutMs: 60 })
  } finally {
    clearTimeout(keepAlive)
  }
  const elapsed = Date.now() - started
  assert.equal(results['alpha/hang'].state, 'unknown', '超时不能被读成对模型的裁决')
  assert.match(String(results['alpha/hang'].detail), /探测超时/)
  assert.equal(results['alpha/fast'].state, 'available')
  assert.equal(results['beta/x'].state, 'available')
  assert.equal(results['gamma/y'].state, 'available')
  const hangAt = fake.order.indexOf('alpha/hang')
  for (const id of ['alpha/fast', 'beta/x', 'gamma/y']) {
    assert.ok(fake.order.indexOf(id) < hangAt, `${id} 应当先于卡死行完成（顺序 ${fake.order.join(' → ')}）`)
  }
  assert.ok(elapsed < 500, `整轮 ${elapsed} ms 超出了「只等一个超时」的预期`)
})

console.log(`\nstandalone-channel-probe-scheduler: ${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
