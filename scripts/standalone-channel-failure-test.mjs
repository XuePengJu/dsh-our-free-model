/**
 * 独立渠道的三处失败语义回归：
 *
 * 1. 「限流被误报成未登录」——账号池的候选全落在限流窗口内时，必须抛带解禁
 *    时间的配额错误，而不是 `no usable credential; log in first`；真的没有
 *    凭据时才保留后者。这里挂载**生成的** business.mjs（不是 vendor 源包），
 *    所以断言的是真正上线的那份产物。
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
  await check('账号全在限流窗口内时报「限流中·何时解禁」，不再误报「请先登录」', async () => {
    const credentials = { QODER_ACCOUNT_FIXTURE: liveCredential() }
    const mounted = await mountChannels({
      state: { accounts: [account('qoder-fixture', 'qoder', 'QODER_ACCOUNT_FIXTURE', { qmodel_38max: Date.now() + 3600_000 })], disabledModels: {} },
      credentials,
    })
    try {
      const error = await captureStreamError(mounted.adapters.get('qoder'), 'qmodel_38max')
      assert.ok(error, '限流账号上发起调用必须失败')
      assert.equal(error.code, 'QUOTA_EXCEEDED')
      assert.match(error.message, /限流中/)
      assert.match(error.message, /解禁/)
      assert.match(error.message, /无需重新登录/)
      assert.doesNotMatch(error.message, /no usable credential/, '限流不是「没有凭据」，不能把用户赶去重新登录')
    } finally { await mounted.dispose() }
  })

  await check('限流窗口已过期 / 另有未限流账号时都不拦门（不抛配额错误）', async () => {
    const expired = await mountChannels({
      state: { accounts: [account('qoder-stale', 'qoder', 'QODER_ACCOUNT_FIXTURE', { qmodel_38max: Date.now() - 1000 })], disabledModels: {} },
      credentials: { QODER_ACCOUNT_FIXTURE: liveCredential() },
    })
    const mixed = await mountChannels({
      state: { accounts: [
        account('qoder-limited', 'qoder', 'QODER_ACCOUNT_FIXTURE', { qmodel_38max: Date.now() + 3600_000 }),
        account('qoder-free', 'qoder', 'QODER_ACCOUNT_FIXTURE'),
      ], disabledModels: {} },
      credentials: { QODER_ACCOUNT_FIXTURE: liveCredential() },
    })
    try {
      for (const mounted of [expired, mixed]) {
        const error = await captureStreamError(mounted.adapters.get('qoder'), 'qmodel_38max')
        // 越过闸门后由 ensureUid 以「凭据缺 uid」收尾：能走到这里就说明账号池放行了。
        assert.equal(error?.code, 'MISSING_CREDENTIAL')
        assert.notEqual(error?.code, 'QUOTA_EXCEEDED', '还有可用账号/窗口已过期时不该报限流')
      }
    } finally { await expired.dispose(); await mixed.dispose() }
  })

  await check('真的没有凭据时仍如实报 MISSING_CREDENTIAL（codearts 无账号）', async () => {
    const mounted = await mountChannels({ state: { accounts: [], disabledModels: {} }, credentials: {} })
    try {
      const error = await captureStreamError(mounted.adapters.get('codearts'), 'fixture-model')
      assert.ok(error, '无账号无凭据时必须失败')
      assert.equal(error.code, 'MISSING_CREDENTIAL')
      assert.match(error.message, /no usable credential/)
      assert.doesNotMatch(error.message, /限流中/, '没有凭据不是限流，不该报限流')
    } finally { await mounted.dispose() }
  })

  await check('探测归类：限流、需登录、模型不存在、5xx 各自落点', async () => {
    const at = Date.now()
    assert.deepEqual(classifyChannelFailure({ code: 'QUOTA_EXCEEDED', message: '均在限流中' }, at), { state: 'throttled', detail: '均在限流中', latencyMs: 0 })
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
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nstandalone-channel-failure: ${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
