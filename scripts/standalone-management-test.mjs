import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { verifyLoginLaunchers, verifyLoginTerminal } from './standalone-login-terminal-test.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-management-'))
const dataDir = path.join(scratch, 'data')
const model = 'mimo-v2.6-flash-free'
const kilo = 'nvidia/nemotron-3.5-lightning:free'
let calls = 0
let holdNextCall = false
// 推理 POST 一律 500 的开关：钉「整链耗尽也会记失败回合」用。
let failPosts = false
let notifyCall
let notifyClosed
const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: req.url === '/models'
        ? [{ id: kilo, isFree: true, name: '测试免费模型' }]
        : [{ id: model }] }))
    } else {
      calls++
      if (holdNextCall) {
        holdNextCall = false
        res.once('close', () => notifyClosed())
        notifyCall()
        return
      }
      if (failPosts) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'upstream exploded on purpose' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''))
    }
  })
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
const base = `http://127.0.0.1:${upstream.address().port}`
process.env.OUR_FREE_MODEL_BASE = base
process.env.OUR_FREE_MODEL_KILO_BASE = base
const { startStandalone } = await import('../packages/standalone/service.mjs')
let service
let cookie
let key
let failures = 0
let checks = 0
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`) }
}
const getKey = () => JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
const request = async (route, { body, cookie: cookieValue = cookie, headers = {}, method } = {}) => {
  if (headers.host) {
    // fetch 会自行设置 Host；用真实 HTTP 请求验证恶意 Host，不误测客户端归一化。
    return new Promise((resolve, reject) => {
      const raw = http.request(service.url + route, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { cookie: cookieValue ?? '', 'content-type': 'application/json', ...headers },
      }, res => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode }))
      })
      raw.once('error', reject)
      raw.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  const response = await fetch(service.url + route, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...cookieValue ? { cookie: cookieValue } : {},
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      connection: 'close',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  return response
}
const login = async body => {
  const response = await request('/api/management/session', { body, cookie: '' })
  assert.equal(response.status, 200)
  const setCookie = response.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, /Path=\/api\/management/)
  return setCookie.split(';')[0]
}

try {
  await check('macOS 与 Windows 固定启动器安全引用路径，令牌只经 stdin 复制', verifyLoginLaunchers)
  await check('本机取令牌入口限制来源与参数，拒绝并发且不泄露密钥或创建会话', verifyLoginTerminal)
  service = await startStandalone({ dataDir, port: 0, refresh: false, logger: { warn() {} } })
  key = getKey()
  await check('页面资源本地提供且不包含密钥，健康接口仍兼容', async () => {
    const page = await request('/', { cookie: '' })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
    const body = await page.text()
    assert.match(body, /本地控制台/)
    assert.match(page.headers.get('content-security-policy'), /script-src 'self';/)
    const scripts = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    assert.ok(scripts.length > 0)
    assert.ok(scripts.every(([, attributes, content]) => /\bsrc=/.test(attributes) && !content.trim()),
      '管理页脚本必须通过同源外部资源加载，不能依赖被 CSP 禁止的内联脚本')
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported'
    assert.ok(body.includes(`data-login-platform="${platform}"`))
    assert.ok(!body.includes(key))
    const manifest = JSON.parse(fs.readFileSync(new URL('../packages/standalone/web/assets.json', import.meta.url), 'utf8'))
    assert.ok(manifest.includes('app.js') && manifest.includes('app.css'))
    assert.ok(manifest.some(name => /^channels-.+\.js$/.test(name)))
    for (const asset of manifest) {
      const response = await request(`/assets/${asset}`, { cookie: '' })
      assert.equal(response.status, 200, asset)
      assert.match(response.headers.get('content-type'), asset.endsWith('.css') ? /text\/css/ : /javascript/)
      assert.ok(!(await response.text()).includes(key), asset)
      assert.equal((await request(`/assets/${asset}`, { method: 'HEAD' })).status, 200)
      assert.equal((await request(`/assets/${asset}`, { method: 'POST' })).status, 405)
    }
    for (const route of ['/assets/settings.json', '/assets/assets.json', '/assets/unknown.js', '/frontend/app.tsx', '/assets/%2e%2e%2fservice.mjs']) {
      assert.equal((await request(route, { cookie: '', headers: { authorization: `Bearer ${key}` } })).status, 404, route)
    }
    const health = await (await request('/health')).json()
    assert.equal(health.product, 'standalone')
    assert.equal(health.capabilities.webUi, true)
  })
  await check('所有管理数据和操作要求登录，OPTIONS 不放行跨域', async () => {
    for (const route of ['summary', 'stats', 'key']) assert.equal((await request(`/api/management/${route}`, { cookie: '' })).status, 401)
    for (const route of ['settings', 'key/rotate', 'models/refresh', 'models/test']) {
      assert.equal((await request(`/api/management/${route}`, { body: {}, cookie: '' })).status, 401)
    }
    const response = await request('/api/management/settings', { cookie: '', method: 'OPTIONS' })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })
  await check('一次性链接只兑换一次，错误凭证不消耗有效凭证', async () => {
    const bootstrapToken = new URLSearchParams(new URL(service.managementUrl).hash.slice(1)).get('login')
    assert.ok(bootstrapToken)
    assert.ok(!service.managementUrl.includes(key))
    assert.equal((await request('/api/management/session', { cookie: '', body: { bootstrapToken: 'wrong' } })).status, 401)
    cookie = await login({ bootstrapToken })
    assert.equal((await request('/api/management/session', { cookie: '', body: { bootstrapToken } })).status, 401)
    const secondCookie = await login({ key })
    assert.notEqual(cookie, secondCookie)
  })
  await check('同源防护覆盖登录、读取和写入，拒绝伪造 Host 及插件来源', async () => {
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: 'http://127.0.0.1:1' },
      { referer: 'http://evil.example/' },
      { referer: 'dsh-app://app' },
      { 'sec-fetch-site': 'cross-site' },
      { host: 'evil.example' },
    ]) {
      assert.equal((await request('/api/management/summary', { headers })).status, 403, JSON.stringify(headers))
      assert.equal((await request('/api/management/settings', { headers, body: { enabled: false } })).status, 403)
      assert.equal((await request('/api/management/session', { headers, body: { key } })).status, 403)
    }
    const response = await request('/api/management/settings', { body: {}, headers: { origin: service.url, referer: `${service.url}/` } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })
  await check('登录前令牌自动读取仅限同源回环页面，跨站与伪造 Host 一律拒绝', async () => {
    const ok = await request('/api/management/local-key', { cookie: '', headers: { 'sec-fetch-site': 'same-origin' } })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).key, key)
    // 同站跨端口的本机应用（same-site）、跨站脚本、无浏览器标记的调用都不算登录页自身。
    for (const site of ['cross-site', 'same-site', 'none']) {
      assert.equal((await request('/api/management/local-key', { cookie: '', headers: { 'sec-fetch-site': site } })).status, 403, site)
    }
    assert.equal((await request('/api/management/local-key', { cookie: '' })).status, 403)
    // DNS rebinding：sec-fetch-site 是 same-origin 但 Host 不是回环名。
    assert.equal((await request('/api/management/local-key', { cookie: '', headers: { 'sec-fetch-site': 'same-origin', host: 'evil.example' } })).status, 403)
    // 反向代理经转发头识别：nginx proxy_set_header 强制注入，远程域名访问即使
    // Host 被改写回 127.0.0.1 且 sec-fetch-site=same-origin 也拿不到本机令牌。
    for (const header of ['x-forwarded-for', 'x-real-ip', 'x-forwarded-proto']) {
      assert.equal((await request('/api/management/local-key', { cookie: '', headers: { 'sec-fetch-site': 'same-origin', [header]: '203.0.113.9' } })).status, 403, header)
    }
    // 显式部署声明：OFM_BEHIND_PROXY 非空时自动令牌整体关闭（请求不带任何转发头也拒绝）。
    process.env.OFM_BEHIND_PROXY = '1'
    try {
      assert.equal((await request('/api/management/local-key', { cookie: '', headers: { 'sec-fetch-site': 'same-origin' } })).status, 403)
    } finally { delete process.env.OFM_BEHIND_PROXY }
    // 开关撤除后恢复放行，防止判据被环境残留误伤。
    assert.equal((await request('/api/management/local-key', { cookie: '', headers: { 'sec-fetch-site': 'same-origin' } })).status, 200)
  })
  await check('设置严格校验字段类型范围和请求体，不发生部分保存', async () => {
    for (const body of [
      null, [], { enabled: 'false' }, { enabled: false, unknown: 1 },
      { forwardKey: 'injected' }, { standalonePort: 80 }, { defaultMaxTokens: 0 },
      { defaultMaxTokens: 131073 }, { probeIntervalMinutes: 0 },
      { probeIntervalMinutes: 1441 }, { probeIntervalMinutes: '15' },
      { standaloneProbe: {} }, { enabled: false, probeIntervalMinutes: 0 },
      { hideFreeModels: 'true' }, { hideEacModels: 1 }, { hiddenModelIds: null },
      { hiddenModelIds: [1] }, { hiddenModelIds: [''] }, { hiddenModelIds: [' x'] },
      { hiddenModelIds: ['x\n'] }, { hiddenModelIds: ['x'.repeat(301)] },
      { hiddenModelIds: Array(1001).fill('model') },
      { enabled: false, hiddenModelIds: [false] },
    ]) assert.equal((await request('/api/management/settings', { body })).status, 400)
    assert.equal(getKey(), key)
    assert.equal(service.runtime.state().settings.enabled, true)
    const malformed = await fetch(service.url + '/api/management/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{',
    })
    assert.equal(malformed.status, 400)
    assert.equal((await request('/api/management/settings', { body: {}, headers: { 'content-type': 'text/plain' } })).status, 415)
    assert.equal((await request('/api/management/settings', { body: { huge: 'x'.repeat(17000) } })).status, 413)
  })
  await check('设置保存后立即落盘，推理暂停时管理页面可恢复服务', async () => {
    const patch = { enabled: false, exposeRegionModels: false, streamRecovery: false, standaloneProbe: true, defaultMaxTokens: 8192, probeIntervalMinutes: 12 }
    assert.equal((await request('/api/management/settings', { body: patch })).status, 200)
    const saved = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
    for (const [name, value] of Object.entries(patch)) assert.equal(saved[name], value)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status, 503)
    assert.equal((await request('/')).status, 200)
    assert.equal((await request('/api/management/summary')).status, 200)
    const before = calls
    assert.equal((await request('/api/management/models/test', { body: { model } })).status, 503)
    assert.equal(calls, before)
    assert.equal((await request('/api/management/settings', { body: { enabled: true } })).status, 200)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status, 200)
  })
  await check('持久化失败不谎报成功且保留原配置与密钥', async () => {
    const nativeRename = fs.renameSync
    fs.renameSync = (source, target) => {
      if (target === service.keyFile) throw Object.assign(new Error('模拟磁盘不可写'), { code: 'EACCES' })
      return nativeRename(source, target)
    }
    try {
      assert.equal((await request('/api/management/settings', { body: { enabled: false } })).status, 500)
      assert.equal(service.runtime.state().settings.enabled, true)
      assert.equal((await request('/api/management/key/rotate', { body: { confirm: true } })).status, 500)
      assert.equal(service.runtime.state().settings.forwardKey, key)
      assert.equal(getKey(), key)
    } finally { fs.renameSync = nativeRename }
    assert.equal((await request('/api/management/settings', { body: { enabled: true } })).status, 200)
  })
  await check('轮换要求确认，旧密钥与其他会话失效，当前管理会话保留', async () => {
    const other = await login({ key })
    assert.equal((await request('/api/management/key/rotate', { body: {} })).status, 400)
    const rotated = await request('/api/management/key/rotate', { body: { confirm: true } })
    assert.equal(rotated.status, 200)
    const nextKey = (await rotated.json()).key
    assert.notEqual(nextKey, key)
    assert.equal(getKey(), nextKey)
    assert.equal((await request('/api/management/summary', { cookie: other })).status, 401)
    assert.equal((await request('/api/management/summary')).status, 200)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status, 401)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${nextKey}` } })).status, 200)
    assert.equal((await request('/api/management/session', { cookie: '', body: { key } })).status, 401)
    key = nextKey
  })
  await check('会话到期和登出后不能读管理数据', async () => {
    const nativeNow = Date.now
    const started = nativeNow()
    try {
      Date.now = () => started + 8 * 60 * 60_000 + 1000
      assert.equal((await request('/api/management/summary')).status, 401)
    } finally { Date.now = nativeNow }
    cookie = await login({ key })
    const response = await request('/api/management/logout', { body: {} })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
    assert.equal((await request('/api/management/summary')).status, 401)
    cookie = await login({ key })
  })
} finally {
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  const cleanupTarget = fs.realpathSync(scratch)
  assert.ok(cleanupTarget.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(cleanupTarget, { recursive: true, force: true })
}
console.log(`\nstandalone-management: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures ? 1 : 0
