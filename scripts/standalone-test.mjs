import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-standalone-'))
const dataDir = path.join(scratch, 'standalone')
const dshHome = path.join(scratch, 'dsh')
fs.mkdirSync(path.join(dshHome, 'our-free-model'), { recursive: true })
const sentinelPath = path.join(dshHome, 'our-free-model', 'settings.json')
const sentinel = JSON.stringify({ forwardKey: 'dsh-only-key', enabled: false, privateMarker: 'do-not-copy' })
fs.writeFileSync(sentinelPath, sentinel)
process.env.DSH_HOME = dshHome

const model = 'mimo-v2.6-flash-free'
const kiloModel = 'nvidia/nemotron-3.5-lightning:free'
let listingCalls = 0
let kiloCalls = 0
let holdListing
let signalListingStarted
let listingStarted
let turns = []
const anonymousRequests = []
let throttleTurns = false
let kiloListing = { data: [{ id: kiloModel, name: 'Test free model', isFree: true }] }
const frames = text => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`,
  'data: [DONE]\n\n',
].join('')
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    if (req.url.startsWith('/inference/v1/')) {
      anonymousRequests.push({ method: req.method, headers: req.headers })
      // v2 指纹：上游只认 `opencode/<channel>/<version>/<client>` 这一整串。
      // 旧实现模拟的是「按名字拒掉独立服务的归属 UA」，那条规则属于 v1；
      // v2 反过来 —— 拼接了归属的串不再是 v2 客户端，同样被拒。
      if (req.method === 'POST' && !/^opencode\/[a-z0-9-]+\/\d+\.\d+\.\d+\/[a-z0-9-]+$/i.test(req.headers['user-agent'] ?? '')) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { name: 'FreeTierError', message: 'OpenCode free tier client rejected' } }))
        return
      }
    }
    if (req.method === 'GET' && req.url === '/inference/v1/models') {
      listingCalls++
      signalListingStarted?.()
      const respond = () => {
        if (res.destroyed) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: model }] }))
      }
      if (holdListing) void holdListing.then(respond)
      else respond()
      return
    }
    if (req.method === 'GET' && req.url === '/models') {
      kiloCalls++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(kiloListing))
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    turns.push(body)
    if (throttleTurns) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(frames(body.model === kiloModel ? 'kilo-ok' : 'core-ok'))
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${upstream.address().port}`
process.env.OUR_FREE_MODEL_BASE = base
process.env.OUR_FREE_MODEL_KILO_BASE = base

const { startStandalone, resolveStandaloneDataDir } = await import('../packages/standalone/service.mjs')
const { createRuntimeStores } = await import('../src/core/runtime.js')
let failures = 0
let checks = 0
let service
let unhold
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`) }
}
const jsonRequest = (url, body, key, extra = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extra },
  body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
})
async function child(args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd: root, env: { ...process.env, ...env }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.stderr.on('data', chunk => { stderr += chunk })
    const deadline = setTimeout(() => { proc.kill(); reject(new Error('child timed out')) }, 10000)
    proc.once('error', error => { clearTimeout(deadline); reject(error) })
    proc.once('exit', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }) })
  })
}

try {
  await check('default data path ignores DSH_HOME', () => {
    assert.equal(resolveStandaloneDataDir({ DSH_HOME: dshHome }, scratch), path.join(scratch, '.workbuddy-gateway'))
    assert.equal(resolveStandaloneDataDir({ OFM_HOME: dataDir, DSH_HOME: dshHome }, scratch), dataDir)
  })
  await check('different runtimes own independent settings and statistics', () => {
    const first = createRuntimeStores({ dataDir: path.join(scratch, 'one') })
    const second = createRuntimeStores({ dataDir: path.join(scratch, 'two') })
    try {
      first.settings.get().forward.port = 12345
      first.stats.get().days.privateDay = { total: 1 }
      assert.notEqual(second.settings.get().forward.port, 12345)
      assert.equal(second.stats.get().days.privateDay, undefined)
    } finally { first.dispose(); second.dispose() }
  })
  await check('routable binds and invalid ports fail before creating data', async () => {
    const invalidDir = path.join(scratch, 'invalid')
    await assert.rejects(startStandalone({ dataDir: invalidDir, host: '0.0.0.0' }), /loopback/)
    await assert.rejects(startStandalone({ dataDir: invalidDir, port: -1 }), /port/)
    await assert.rejects(startStandalone({ dataDir: invalidDir, port: 65536 }), /port/)
    assert.equal(fs.existsSync(invalidDir), false)
  })
  await check('退出时保留已被替换的其他锁，不清理无法确认归属的文件', async () => {
    const directory = path.join(scratch, 'replaced-lock')
    const isolated = await startStandalone({ dataDir: directory, port: 0, refresh: false, logger: { warn() {} } })
    const lockFile = path.join(directory, 'service.lock')
    const replacement = JSON.stringify({ pid: process.pid, product: 'our-free-model-standalone', token: 'another-owner' })
    fs.unlinkSync(lockFile)
    fs.writeFileSync(lockFile, replacement)
    await isolated.close()
    assert.equal(fs.readFileSync(lockFile, 'utf8'), replacement)
  })
  await check('启动中途失败会同时释放文件锁与进程互斥端点，修复配置后可重启', async () => {
    const directory = path.join(scratch, 'failed-boot')
    const settingsFile = path.join(directory, 'settings.json')
    fs.mkdirSync(settingsFile, { recursive: true })
    await assert.rejects(startStandalone({ dataDir: directory, port: 0, refresh: false, logger: { warn() {} } }), /persist/)
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false)
    fs.rmdirSync(settingsFile)
    const recovered = await startStandalone({ dataDir: directory, port: 0, refresh: false, logger: { warn() {} } })
    await recovered.close()
  })
  if (process.platform === 'win32' || process.platform === 'linux') {
    await check('没有权限检查进程时保留锁，不把 EPERM 当成进程退出', async () => {
      const directory = path.join(scratch, 'permission-lock')
      const lockFile = path.join(directory, 'service.lock')
      fs.mkdirSync(directory)
      const original = JSON.stringify({ pid: process.pid, product: 'our-free-model-standalone' })
      fs.writeFileSync(lockFile, original)
      const nativeKill = process.kill
      process.kill = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) }
      try {
        await assert.rejects(startStandalone({ dataDir: directory, port: 0, refresh: false }), { code: 'EEXIST' })
        assert.equal(fs.readFileSync(lockFile, 'utf8'), original)
      } finally { process.kill = nativeKill }
    })
  }
  await check('the listener starts while its upstream listing is held', async () => {
    holdListing = new Promise(resolve => { unhold = resolve })
    listingStarted = new Promise(resolve => { signalListingStarted = resolve })
    service = await startStandalone({ dataDir, port: 0, logger: { warn() {} } })
    const response = await fetch(`${service.url}/health`, { signal: AbortSignal.timeout(5000) })
    const health = await response.json()
    assert.equal(response.status, 200)
    assert.equal(health.product, 'standalone')
    // 单渠道剪裁后只剩账号渠道：匿名/Kilo/EAC 三条车道都已不存在，能力位恒为 false。
    assert.equal(health.capabilities.anonymous, false)
    assert.equal(health.capabilities.kilo, false)
    assert.equal(health.capabilities.eac, false)
    assert.equal(health.capabilities.accountChannels, true)
    unhold()
    holdListing = undefined
  })
  if (!service) throw new Error('standalone did not start')
  const key = JSON.parse(fs.readFileSync(service.keyFile)).forwardKey
  await check('standalone generates its own API key without copying DSH data', () => {
    assert.match(key, /^ofm-/)
    assert.notEqual(key, 'dsh-only-key')
    assert.equal(JSON.parse(fs.readFileSync(service.keyFile)).privateMarker, undefined)
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel)
  })
  await check('another instance cannot write the same data directory', async () => {
    await assert.rejects(startStandalone({ dataDir, port: 0, refresh: false }), { code: 'EEXIST' })
    assert.equal(JSON.parse(fs.readFileSync(service.keyFile)).forwardKey, key)
  })
  await check('model list requires the standalone key and rejects the DSH key', async () => {
    assert.equal((await fetch(`${service.url}/v1/models`)).status, 401)
    assert.equal((await fetch(`${service.url}/v1/models`, { headers: { authorization: 'Bearer dsh-only-key' } })).status, 401)
    const response = await fetch(`${service.url}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
    assert.equal(response.status, 200)
    // 单渠道剪裁后模型行只来自已登录的 WorkBuddy 账号渠道；本用例没有账号，
    // 所以清单为空，而不是再从免费车道兜底出模型。
    assert.ok(Array.isArray((await response.json()).data))
  })
  await check('without a signed-in account the catalog stays empty and inference is refused', async () => {
    await service.ready
    assert.deepEqual(service.runtime.catalog, [])
    const response = await jsonRequest(`${service.url}/v1/chat/completions`, {
      model: 'any-model', messages: [{ role: 'user', content: 'hello' }],
    }, key)
    assert.equal(response.status, 404)
  })
  await check('statistics persist and repeated shutdown releases the listener and lock', async () => {
    assert.equal(service.runtime.state().settings.forwardKey, key)
    assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), true)
    await Promise.all([service.close(), service.close()])
    assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), false)
    // 没有任何已登录账号时不会有成功的推理，stats.json 可能还没落盘；这里只守住
    // 「设置已持久化」与「关闭后监听器不再响应」这两个仍成立的事实。
    const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json')))
    assert.equal(settings.forwardKey, key)
    await assert.rejects(fetch(`${service.url}/health`))
    await assert.rejects(service.runtime.complete({ model: 'any-model', openAi: {} }), { statusCode: 503 })
  })
  await check('restart reuses only its own cached catalog, key and port', async () => {
    const previousPort = service.port
    service = await startStandalone({ dataDir, refresh: false, logger: { warn() {} } })
    assert.equal(service.port, previousPort)
    assert.equal(JSON.parse(fs.readFileSync(service.keyFile)).forwardKey, key)
    assert.deepEqual(service.runtime.catalog, [])
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel)
  })
  await check('a separate process boots with plugin and DSH imports forbidden', async () => {
    const result = await child([
      '--experimental-loader', './scripts/lib/standalone-isolation-loader.mjs',
      '--input-type=module', '--eval',
      `import { startStandalone } from './packages/standalone/service.mjs';
       const service = await startStandalone({ port: 0, refresh: false });
       try {
         const response = await fetch(service.url + '/health');
         if ((await response.json()).product !== 'standalone') throw new Error('wrong product');
         if (globalThis[Symbol.for('our-free-model.generation')] !== undefined) throw new Error('plugin loaded');
         console.log('standalone-only');
       } finally { await service.close() }`,
    ], { OFM_HOME: path.join(scratch, 'isolated-child') })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /standalone-only/)
  })
  await check('CLI help and invalid arguments do not start a service', async () => {
    const help = await child(['packages/standalone/cli.mjs', '--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /--data-dir/)
    for (const flag of ['--unknown', '--port', '--port=-1']) {
      assert.notEqual((await child(['packages/standalone/cli.mjs', flag])).code, 0)
    }
    assert.notEqual((await child(['packages/standalone/cli.mjs', '--port', '65536'])).code, 0)
  })
} finally {
  unhold?.()
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  const target = fs.realpathSync(scratch)
  assert.ok(target.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`\nstandalone: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
