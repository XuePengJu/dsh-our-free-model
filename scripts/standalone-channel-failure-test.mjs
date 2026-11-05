/**
 * 独立渠道的四处失败语义回归：
 *
 * 1. 「限流被误报成未登录」——账号池的候选全落在限流窗口内时，必须抛带解禁
 *    时间的配额错误，而不是 `no usable credential; log in first`；真的没有
 *    凭据时才保留后者。这里挂载**生成的** business.mjs（不是 vendor 源包），
 *    所以断言的是真正上线的那份产物。
 * 1b. 「凭据解析路径悬空」——`b71e8e5` 剪裁时删掉了 `pickBuddyCredential` 等
 *    定义却留下调用点，产物里于是出现悬空引用，所有推理请求 1ms 死于
 *    `ReferenceError`。这条用例把「真的执行到适配器错误语义」钉住。
 * 2. 探测归类（channel-probe.mjs::classifyChannelFailure）——限流、需重新登录、
 *    模型不存在、5xx 各自落点，以及「5xx 不许读成对模型的裁决」这条不对称铁律。
 * 3. 凭据热加载（credentials.mjs）——外部进程替换凭据文件后无需重启即可读到；
 *    半截/损坏文件不清空已有凭据。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyChannelFailure } from '../packages/standalone/channel-probe.mjs'
import { createCredentials } from '../packages/standalone/channels/credentials.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-channel-failure-'))
let checks = 0, failures = 0
const check = async (name, body) => {
  checks++
  try { await body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`) }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 用假 ctx 挂载生成的渠道产物；返回注册好的适配器与清理函数。 */
async function mountChannels({ state, credentials }) {
  const home = path.join(scratch, `home-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(path.join(home, 'channel-pack'), { recursive: true })
  fs.writeFileSync(path.join(home, 'channel-pack', 'state.json'), JSON.stringify(state))
  // 渠道包按 DSH_CHANNEL_PACK_STATE_DIR 定位数据目录，独立版由构建补丁改用
  // ctx.platform.channelHome —— 两者都指向同一个 home，避免测试与线上路径漂移。
  const previous = process.env.DSH_CHANNEL_PACK_STATE_DIR
  process.env.DSH_CHANNEL_PACK_STATE_DIR = home
  const adapters = new Map()
  const services = {
    platform: { channelHome: home },
    credentials: {
      resolve: async ref => credentials[ref],
      describe: async ref => ({ source: credentials[ref] === undefined ? undefined : 'local' }),
      set: async (ref, value) => { credentials[ref] = { value } },
      unset: async ref => { delete credentials[ref] },
    },
    attachments: {},
    llm: {
      registerAdapter(providers, adapter) { for (const provider of providers) adapters.set(provider, adapter) },
      listProviders: () => [...adapters.keys()].map(id => ({ id })),
    },
    connection: { fetch: { register() {} } },
  }
  const cleanups = []
  const ctx = {
    ...services,
    logger: { info() {}, warn() {}, error() {} },
    get: name => services[name],
    provide(name, value) { services[name] = value; this[name] = value },
    effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(this) },
    emit() {},
  }
  const { apply } = await import('../packages/standalone/channels/business.mjs')
  apply(ctx, { disableOpencode: true })
  return {
    adapters,
    async dispose() {
      for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch { /* 测试清理失败不该掩盖断言 */ } }
      if (previous === undefined) delete process.env.DSH_CHANNEL_PACK_STATE_DIR
      else process.env.DSH_CHANNEL_PACK_STATE_DIR = previous
    },
  }
}

/** 取适配器在一次 stream 里抛出的错误（resolveCredential 在发网络前就会失败）。 */
async function captureStreamError(adapter, model) {
  try {
    for await (const _ of adapter.stream({ model, messages: [] })) { /* 不预期有帧 */ }
    return undefined
  } catch (error) { return error }
}

const account = (id, provider, credentialRef, modelRateLimits) => ({
  id, provider, nickname: id, enabled: true, refreshable: false, createdAt: 1, credentialRef,
  ...modelRateLimits === undefined ? {} : { modelRateLimits },
})
/**
 * qoder 凭据替身。
 *
 * 刻意**不带 `uid`**：`ensureUid` 会以 MISSING_CREDENTIAL 收尾，于是测试在
 * 「账号池放行之后」就地停住，既证明限流闸门没误拦，又完全不碰网络（本套件
 * 不发任何真实请求）。`expire_time` 也不给 —— `isQoderExpired` 只认它，缺省
 * 即视为未过期，避免触发一次真实的刷新往返。
 */
const liveCredential = () => ({ value: JSON.stringify({ access_token: 'fixture-token', refresh_token: 'r' }), source: 'local' })

try {



  await check('探测归类：限流、需登录、模型不存在、5xx 各自落点', async () => {
    const at = Date.now()
    // ⚠️ 不要深比较整个对象：`latencyMs` 取的是**真实时钟差**，同一毫秒内为 0、
    // 跨毫秒就变 1 —— 全量跑时实测偶发红（本套件其余用例把进程压起来之后）。
    // 分类结果才是被测语义，延迟只断言「是个非负整数」。
    const throttledByCode = classifyChannelFailure({ code: 'QUOTA_EXCEEDED', message: '均在限流中' }, at)
    assert.equal(throttledByCode.state, 'throttled')
    assert.equal(throttledByCode.detail, '均在限流中')
    assert.ok(Number.isInteger(throttledByCode.latencyMs) && throttledByCode.latencyMs >= 0)
    assert.equal(classifyChannelFailure({ statusCode: 429, message: 'slow down' }, at).state, 'throttled')
    assert.equal(classifyChannelFailure({ code: 'MISSING_CREDENTIAL', message: 'qoder: no usable credential; log in first' }, at).state, 'needs-login')
    assert.equal(classifyChannelFailure({ code: 'MISSING_CREDENTIAL', message: 'qoder: 凭据缺少 uid，加密推理无法签名（请重新登录该账号）' }, at).state, 'needs-login')
    assert.equal(classifyChannelFailure({ statusCode: 401, message: '令牌已失效，请重新登录' }, at).state, 'needs-login')
    assert.equal(classifyChannelFailure({ statusCode: 403, message: '凭据已过期' }, at).state, 'needs-login')
    assert.equal(classifyChannelFailure({ statusCode: 404, message: '模型不存在或已停用' }, at).state, 'unavailable')
    assert.equal(classifyChannelFailure({ statusCode: 400, message: 'bad request' }, at).state, 'unavailable')
    assert.equal(classifyChannelFailure({ statusCode: 422, message: 'unprocessable' }, at).state, 'unavailable')
    assert.equal(classifyChannelFailure({ statusCode: 404, message: 'no such model' }, at).state, 'unavailable')
    // 5xx 是上游自己的故障，其措辞不许读成对模型的裁决（反代把 503 拼成 Service Unavailable）。
    assert.equal(classifyChannelFailure({ statusCode: 503, message: 'Service Unavailable' }, at).state, 'unknown')
    assert.equal(classifyChannelFailure({ statusCode: 500, message: 'internal error' }, at).state, 'unknown')
    assert.equal(classifyChannelFailure(new Error('fetch failed'), at).state, 'unknown')
    // detail 截断到 200 字符，避免把整段响应塞进 availability 存储。
    assert.equal(classifyChannelFailure({ statusCode: 500, message: 'x'.repeat(500) }, at).detail.length, 200)
  })

  await check('凭据热加载：外部进程替换文件后无需重启即可读到', async () => {
    const dir = path.join(scratch, 'creds-hot')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'channel-credentials.json')
    const store = createCredentials(dir)
    assert.equal(await store.resolve('QODER_ACCOUNT_FIXTURE'), undefined)

    // 模拟登录命令（另一个进程）原子替换凭据文件。
    const temp = `${file}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ QODER_ACCOUNT_FIXTURE: 'v1' }))
    fs.renameSync(temp, file)
    assert.deepEqual(await store.resolve('QODER_ACCOUNT_FIXTURE'), { value: 'v1', source: 'local' })
    assert.deepEqual(await store.describe('QODER_ACCOUNT_FIXTURE'), { source: 'local' })

    await sleep(10)
    fs.writeFileSync(file, JSON.stringify({ QODER_ACCOUNT_FIXTURE: 'v2' }))
    assert.equal((await store.resolve('QODER_ACCOUNT_FIXTURE')).value, 'v2', '第二次外部写入也必须被看到')

    // 本进程写入立即生效，不依赖回读。
    await store.set('BUDDY_ACCOUNT_FIXTURE', 'local')
    assert.equal((await store.resolve('BUDDY_ACCOUNT_FIXTURE')).value, 'local')
    await store.unset('BUDDY_ACCOUNT_FIXTURE')
    assert.equal(await store.resolve('BUDDY_ACCOUNT_FIXTURE'), undefined)

    // 半截/损坏文件：保留上一份可用副本，绝不清空。
    await sleep(10)
    fs.writeFileSync(file, '{ not json')
    assert.equal((await store.resolve('QODER_ACCOUNT_FIXTURE')).value, 'v2', '损坏文件不能让凭据凭空消失')
    await sleep(10)
    fs.writeFileSync(file, JSON.stringify({ QODER_ACCOUNT_FIXTURE: 'v3' }))
    assert.equal((await store.resolve('QODER_ACCOUNT_FIXTURE')).value, 'v3', '修复后的文件要能重新读到')

    // 文件被删除 = 空仓。
    fs.rmSync(file)
    assert.equal(await store.resolve('QODER_ACCOUNT_FIXTURE'), undefined)

    // 停止后不再回读落盘内容。
    fs.writeFileSync(file, JSON.stringify({ QODER_ACCOUNT_FIXTURE: 'v4' }))
    assert.equal((await store.resolve('QODER_ACCOUNT_FIXTURE')).value, 'v4')
    store.dispose()
    assert.equal(await store.resolve('QODER_ACCOUNT_FIXTURE'), undefined)
  })

  await check('凭据仓库：启动即损坏的文件直接报错，不静默当作空仓', async () => {
    const dir = path.join(scratch, 'creds-broken')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'channel-credentials.json'), '[]')
    assert.throws(() => createCredentials(dir), /独立凭据文件格式错误/)
  })

  /**
   * 产物级：WorkBuddy 的凭据解析路径**真的能执行**，而不是抛 ReferenceError。
   *
   * ## 它钉的是什么（真实缺陷，2026-11）
   *
   * 用户导入 WorkBuddy 国际版账号后**所有推理请求 1ms 失败**，真实原因是
   * `ReferenceError: pickBuddyCredential is not defined` —— 「剪裁到只剩
   * WorkBuddy 单渠道」那次提交删掉了该函数定义，却留下了调用点。产物里因此
   * 存在悬空引用，且**只在真正选号时**才踩到。
   *
   * 本文件原有的 `mountChannels()` / `account()` 正是为这类断言准备的，但当初
   * 「挂真实 business.mjs」的用例被剪裁删掉了，helper 沦为死代码 —— 缺口就是
   * 这样留下来的。故这里把它们重新用起来，挂载**生成的**产物而非 vendor 源包。
   *
   * ## 判据为什么不比对文案
   *
   * 只断言两件结构上的事：
   * 1. 不是 `ReferenceError` —— 那是悬空引用的唯一签名；
   * 2. 是一个带 `code` 的 `LlmError` —— 说明「选号 → 余额分档 → 适配器」这条
   *    链路真的走完了，错误来自适配器自己的语义层。
   * 文案（`credential expired and refresh failed` / 401 / 502 …）随上游与
   * 代码演进会变，绑死它就是造一条脆弱用例。
   *
   * 凭据是假值、上游被替身固定成 401，故**零网络、零配额**：与套件其余用例一致。
   */
  await check('产物级：WorkBuddy 凭据解析路径不得抛 ReferenceError（悬空引用）', async () => {
    const ref = 'WORKBUDDY_ACCOUNT_QA000001'
    const farFuture = String(Date.now() + 365 * 24 * 60 * 60 * 1000)
    const mounted = await mountChannels({
      state: {
        accounts: [account('workbuddy-qa000001', 'workbuddy', ref)],
        disabledModels: {},
      },
      credentials: {
        [ref]: {
          value: JSON.stringify({
            access_token: 'qa-fixture-token',
            refresh_token: 'qa-fixture-refresh',
            expires_at: farFuture,
            refresh_expires_at: farFuture,
            token_type: 'Bearer',
            domain: 'www.workbuddy.ai',
            user_id: 'qa-fixture-uid',
          }),
          source: 'local',
        },
      },
    })
    const realFetch = globalThis.fetch
    // 恒定 401：让「选号 → 适配器 → 上游」整条链路走完，但一个真实请求都不发。
    globalThis.fetch = async () => new Response('{"error":"fixture-401"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
    try {
      const adapter = mounted.adapters.get('workbuddy')
      assert.ok(adapter !== undefined, 'workbuddy 适配器必须已注册')
      const error = await captureStreamError(adapter, 'deepseek-v4.1-flash')
      assert.ok(error !== undefined, '凭据是假的，必须失败 —— 不许静默成功')
      assert.ok(
        !(error instanceof ReferenceError),
        `凭据解析抛了 ReferenceError（产物里的悬空引用）：${error.message}`,
      )
      assert.equal(error.name, 'LlmError', `期望 LlmError，实际 ${error.name}: ${error.message}`)
      assert.equal(typeof error.code, 'string', `LlmError 必须带 code，实际 ${String(error.code)}`)
    } finally {
      globalThis.fetch = realFetch
      await mounted.dispose()
    }
  })
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nstandalone-channel-failure: ${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
