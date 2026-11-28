import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-desktop-bootstrap-'))
const dataDir = path.join(scratch, 'data')
const clock = path.join(scratch, 'clock.json')
const preload = path.join(scratch, 'offline-clock.mjs')
const children = new Set()
let checks = 0
const check = async (name, run) => { await run(); console.log(`ok ${++checks} ${name}`) }
fs.writeFileSync(clock, '0')
fs.writeFileSync(preload, `
import fs from 'node:fs';
const now = Date.now;
Date.now = () => now() + JSON.parse(fs.readFileSync(${JSON.stringify(clock)}, 'utf8'));
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return ['127.0.0.1', 'localhost'].includes(url.hostname) ? original(input, init) : Promise.resolve(Response.json({ data: [] }));
};
`)

function launch() {
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href,
    path.join(root, 'packages/desktop/service-host.mjs'), '--port', '0', '--no-refresh', '--data-dir', dataDir],
  { cwd: scratch, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  const messages = []
  const pending = new Map()
  let output = '', stderr = ''
  const finish = (key, error, value) => {
    const item = pending.get(key)
    if (!item) return
    pending.delete(key); clearTimeout(item.timer)
    if (error) item.reject(error); else item.resolve(value)
  }
  const exit = once(child, 'exit')
  child.once('exit', () => {
    for (const key of pending.keys()) finish(key, new Error(`Service exited: ${stderr.slice(0, 200)}`))
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    output += chunk
    const lines = output.split('\n'); output = lines.pop()
    for (const line of lines) {
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (!message.protocol?.startsWith('ofm-desktop-')) continue
      messages.push(message)
      finish(message.requestId ?? 'ready', null, message)
    }
  })
  const wait = (id, timeout = 15_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(id, new Error(`Service response timed out: ${id}`)), timeout)
    pending.set(id, { resolve, reject, timer })
  })
  return {
    child, messages,
    ready: () => messages.find(message => message.protocol === 'ofm-desktop-ready/v1') ?? wait('ready'),
    bootstrap(requestId) {
      const response = wait(requestId, 5000)
      child.stdin.write(JSON.stringify({ protocol: 'ofm-desktop-command/v1', command: 'bootstrap', requestId }) + '\n')
      return response
    },
    async stop(eof = false) {
      if (child.exitCode === null) child.stdin.end(eof ? undefined : 'shutdown\n')
      const timer = setTimeout(() => child.kill(), 10_000)
      try {
        const [code] = await exit
        assert.equal(code, 0)
        assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), false)
        children.delete(child)
      } finally { clearTimeout(timer) }
    },
  }
}

const login = (address, cookie = '', token) => {
  const url = new URL(address)
  return fetch(`${url.origin}/api/management/session`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ bootstrapToken: token ?? new URLSearchParams(url.hash.slice(1)).get('login') }) })
}
const cookieOf = response => response.headers.get('set-cookie').split(';')[0]

try {
  const first = launch()
  const ready = await first.ready()
  assert.equal(ready.protocol, 'ofm-desktop-ready/v1')
  const origin = new URL(ready.managementUrl).origin
  const settings = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
  const key = settings().forwardKey
  let cookie, beforeRestartUrl
  await check('expired startup link can be replaced only through the private parent pipe', async () => {
    fs.writeFileSync(clock, String(11 * 60_000))
    assert.equal((await login(ready.managementUrl)).status, 401)
    const response = await first.bootstrap('expired_startup')
    assert.equal(response.protocol, 'ofm-desktop-bootstrap/v1')
    assert.equal(response.requestId, 'expired_startup')
    assert.equal(response.pid, first.child.pid)
    assert.equal(response.port, ready.port)
    assert.equal(new URL(response.managementUrl).origin, origin)
    assert.match(new URL(response.managementUrl).hash, /^#login=[\w-]{43}$/)
    assert.ok(!response.managementUrl.includes(key))
    const session = await login(response.managementUrl)
    assert.equal(session.status, 200)
    cookie = cookieOf(session)
    assert.equal((await login(response.managementUrl)).status, 401)
    assert.equal(settings().forwardKey, key)
  })
  await check('HTTP does not expose a bootstrap mint or relax cross-site authentication', async () => {
    for (const route of ['/bootstrap', '/login/bootstrap']) {
      const response = await fetch(`${origin}/api/management${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(response.status, 401)
    }
    assert.equal((await fetch(`${origin}/api/management/summary`)).status, 401)
    const response = await fetch(`${origin}/api/management/session`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
      body: '{}' })
    assert.equal(response.status, 403)
  })
  await check('concurrent requests correlate IDs and only the latest capability can be exchanged', async () => {
    const [left, right] = await Promise.all([first.bootstrap('concurrent_a'), first.bootstrap('concurrent_b')])
    assert.equal(left.requestId, 'concurrent_a')
    assert.equal(right.requestId, 'concurrent_b')
    assert.notEqual(left.managementUrl, right.managementUrl)
    assert.equal((await login(left.managementUrl)).status, 401)
    const session = await login(right.managementUrl, cookie)
    assert.equal(session.status, 200)
    const previous = cookie
    cookie = cookieOf(session)
    assert.equal((await fetch(`${origin}/api/management/summary`, { headers: { cookie: previous } })).status, 401)
  })
  await check('repeated desktop opens replace the same cookie without exhausting 64 sessions', async () => {
    for (let index = 0; index < 66; index++) {
      const response = await first.bootstrap(`reopen_${index}`)
      const session = await login(response.managementUrl, cookie)
      assert.equal(session.status, 200, `reopen ${index}`)
      cookie = cookieOf(session)
    }
    assert.equal((await fetch(`${origin}/api/management/summary`, { headers: { cookie } })).status, 200)
  })
  await check('expired sessions still require a new one-time link and keep the 8h cookie bound', async () => {
    const elapsed = 11 * 60_000 + 8 * 60 * 60_000 + 1_000
    fs.writeFileSync(clock, String(elapsed))
    assert.equal((await fetch(`${origin}/api/management/summary`, { headers: { cookie } })).status, 401)
    const expired = await first.bootstrap('new_link_timeout')
    fs.writeFileSync(clock, String(elapsed + 11 * 60_000))
    assert.equal((await login(expired.managementUrl)).status, 401)
    const response = await first.bootstrap('expired_session')
    const session = await login(response.managementUrl, cookie)
    assert.equal(session.status, 200)
    assert.match(session.headers.get('set-cookie'), /Max-Age=28800/)
    cookie = cookieOf(session)
  })
  await check('malformed commands are ignored and shutdown cleans up the owned child lock', async () => {
    for (const command of ['not json', JSON.stringify({ protocol: 'wrong', command: 'bootstrap', requestId: 'foreign' }),
      JSON.stringify({ protocol: 'ofm-desktop-command/v1', command: 'bootstrap', requestId: 'x'.repeat(65) }),
      JSON.stringify({ protocol: 'ofm-desktop-command/v1', command: 'bootstrap', requestId: { object: true } })]) {
      first.child.stdin.write(command + '\n')
    }
    const response = await first.bootstrap('after_invalid')
    assert.equal(response.requestId, 'after_invalid')
    assert.equal(first.messages.filter(message => message.requestId === 'foreign').length, 0)
    assert.ok(first.messages.every(message => message.requestId === undefined || typeof message.requestId === 'string'))
    beforeRestartUrl = response.managementUrl
    await first.stop()
  })
  await check('restart invalidates old sessions and bootstrap links while preserving the permanent key', async () => {
    const restarted = launch()
    const next = await restarted.ready()
    assert.notEqual(next.pid, ready.pid)
    assert.equal(settings().forwardKey, key)
    const nextOrigin = new URL(next.managementUrl).origin
    const restartedCookie = `ofm_management_${next.port}=${cookie.slice(cookie.indexOf('=') + 1)}`
    assert.equal((await fetch(`${nextOrigin}/api/management/summary`, { headers: { cookie: restartedCookie } })).status, 401)
    const oldToken = new URLSearchParams(new URL(beforeRestartUrl).hash.slice(1)).get('login')
    assert.equal((await login(next.managementUrl, '', oldToken)).status, 401)
    assert.equal((await login(next.managementUrl)).status, 200)
    const fresh = await restarted.bootstrap('after_restart')
    assert.equal((await login(fresh.managementUrl)).status, 200)
    await restarted.stop(true)
  })
  console.log(`${checks}/${checks} desktop bootstrap checks passed`)
} finally {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exit = once(child, 'exit')
    child.kill(); await exit
  }
  assert.ok(scratch.startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(scratch, { recursive: true, force: true })
}
