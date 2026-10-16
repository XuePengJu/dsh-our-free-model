/** 使用真实构建资源和隔离接口，验证 React 应用的跨页面状态及会话边界。 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { createManagement } from '../packages/standalone/management.mjs'
import { buildStats } from '../src/core/stats.js'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'playwright')
const management = createManagement({ stores: { settings: { get: () => ({ forwardKey: 'isolated' }) } }, info: () => ({}) })
const server = http.createServer((req, res) => { void management.handleRequest(req, res) })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const baseUrl = `http://127.0.0.1:${server.address().port}`
management.setPort(server.address().port)
const browser = await chromium.launch({ headless: true })
const settings = { enabled: true, exposeRegionModels: true, streamRecovery: true, standaloneProbe: false, defaultMaxTokens: 32768, probeIntervalMinutes: 15 }
let loggedIn = false, key = 'ofm-ui-isolated-key', summaryReads = 0, legacyStats = false
const summary = () => ({ version: 'test', baseUrl, dataDir: 'isolated', networkMode: 'fixture', automaticRefresh: false,
  catalogSyncedAt: 0, settings: { ...settings }, channels: { state: 'ready' }, eacAuth: { local: false },
  catalog: [{ id: 'fixture/model', name: '测试模型', channel: 'anonymous', routable: true, availability: 'available' }] })
const catalog = () => summary().catalog
const localDayKey = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
/** 带四档 periods 的用量夹具：lifetime 回合=10，今日回合=1，用于验证档位联动。 */
const makeUsageStats = () => {
  const days = {}
  for (let i = 6; i >= 0; i -= 1) {
    const at = new Date(); at.setDate(at.getDate() - i)
    const day = localDayKey(at)
    const input = i === 0 ? 100 : 10 + i
    const output = i === 0 ? 50 : 5
    days[day] = {
      total: input + output,
      models: { 'fixture/model': { input, output, reasoning: 0, cacheRead: 0, calls: 1, failed: 0, ttftMs: 100, ttftSamples: 1, decodeMs: 300, decodeTokens: 5 } },
      turns: i === 0 ? 1 : 2, failedTurns: 0, recoveredTurns: i === 0 ? 1 : 0,
      modelsTurns: { 'fixture/model': { turns: i === 0 ? 1 : 2, failed: 0, recovered: i === 0 ? 1 : 0 } },
    }
  }
  return buildStats({
    requests: 10, failedRequests: 1,
    logical: { turns: 10, failed: 2, recovered: 3, models: { 'fixture/model': { turns: 10, failed: 2, recovered: 3 } } },
    models: { 'fixture/model': { input: 5000, output: 2000, reasoning: 30, cacheRead: 0, calls: 10, failed: 1 } },
    days, logicalDailySince: '',
  }, catalog())
}
const legacyStatsPayload = () => { const out = makeUsageStats(); delete out.periods; return out }
const errors = []
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/management/**', async route => {
    const request = route.request(), endpoint = new URL(request.url()).pathname.replace('/api/management', '')
    const body = request.postDataJSON()
    const answer = (value, status = 200) => route.fulfill({ status, json: value })
    if (endpoint === '/session') { loggedIn = body.key === key || body.bootstrapToken === 'test'; return answer(loggedIn ? { ok: true } : { error: '登录令牌无效' }, loggedIn ? 200 : 401) }
    if (!loggedIn) return answer({ error: '管理会话已失效，请重新登录' }, 401)
    if (endpoint === '/summary') { summaryReads++; return answer(summary()) }
    if (endpoint === '/stats') return answer(legacyStats ? legacyStatsPayload() : makeUsageStats())
    if (endpoint === '/settings') { Object.assign(settings, body); return answer({ settings }) }
    if (endpoint === '/key') return answer({ key })
    if (endpoint === '/key/rotate') { key = 'ofm-ui-rotated-key'; return answer({ key }) }
    if (endpoint === '/logout') { loggedIn = false; return answer({ ok: true }) }
    if (endpoint === '/eac/status') return answer({ available: true, authorized: false, local: false, login: '' })
    if (endpoint === '/eac/pool') return answer({ inflight: 0, pool: 100, active24h: 0 })
    if (endpoint === '/channels/rpc') {
      const value = body.method === 'provider.status' ? { statuses: Object.fromEntries(body.payload.providers.map(id => [id, { accounts: { total: 0, enabled: 0 } }])) }
        : body.method === 'usage.autoCheckin' ? { autoCheckin: { enabled: false } }
          : body.method === 'usage.tokenLedger' ? { entries: [] } : {}
      return answer({ ok: true, value })
    }
    return answer({ ok: true })
  })
  const nav = async name => { await page.locator('.console-nav-item').filter({ hasText: name }).click() }
  await page.goto(baseUrl)
  await page.locator('#login-key').fill('bad-key')
  await page.getByRole('button', { name: '进入控制台' }).click()
  await page.getByText('登录令牌无效', { exact: true }).waitFor()
  await page.locator('#login-key').fill(key)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await page.getByTestId('overview-ready').waitFor()
  await nav('模型清单'); await page.getByTestId('models-ready').waitFor()
  await nav('用量统计'); await page.getByTestId('usage-ready').waitFor()
  await nav('服务设置'); await page.getByTestId('settings-ready').waitFor()
  await page.locator('#setting-defaultMaxTokens').fill('8192')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByText('设置已保存并生效', { exact: true }).waitFor()
  assert.equal(settings.defaultMaxTokens, 8192)
  await nav('概览'); await nav('服务设置')
  assert.equal(await page.locator('#setting-defaultMaxTokens').inputValue(), '8192', '保存后的设置应在切页后保持')
  await nav('API 接入'); await page.getByTestId('connection-ready').waitFor()
  await page.getByRole('button', { name: '查看密钥', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('connection-key').value.length > 0)
  assert.equal(await page.locator('#connection-key').inputValue(), key)
  await page.getByRole('button', { name: '隐藏密钥', exact: true }).click()
  assert.equal(await page.locator('#connection-key').inputValue(), '')
  await page.getByRole('button', { name: '复制地址', exact: true }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${baseUrl}/v1`)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '轮换密钥', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('connection-key').value === 'ofm-ui-rotated-key')
  await nav('免费账号渠道'); await page.getByLabel('搜索渠道').waitFor()
  await page.getByRole('tab', { name: '请求日志', exact: true }).click()
  // 等待轮询真实执行；刷新不应重置渠道子页。
  const previousReads = summaryReads
  await page.waitForFunction(() => true)
  const deadline = Date.now() + 20000
  while (summaryReads === previousReads && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(summaryReads > previousReads, '15 秒自动轮询应执行')
  assert.equal(await page.getByRole('tab', { name: '请求日志', exact: true }).getAttribute('aria-selected'), 'true', '刷新不得重置渠道子页')
  await nav('EAC 协付渠道'); await page.getByRole('heading', { name: 'EAC 协付渠道', exact: true }).waitFor()
  await nav('API 接入')
  const imageDir = process.env.OFM_UI_SCREENSHOT_DIR
  if (imageDir) fs.mkdirSync(imageDir, { recursive: true })
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }]]) {
    await page.setViewportSize(viewport)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 不应溢出视口`)
    if (imageDir) await page.screenshot({ path: path.join(imageDir, `react-connection-${name}.png`), fullPage: true })
  }
  // ===== 布局回归：内容列宽度一致性 / 1280 收敛居中 / 两主题一致 / 页脚落底 / 窄栏居中 =====
  // 断言基线：视口 1512（main=1274 未达上限）→ section.page 同 x 同宽 x=238/w=1274；
  // 视口 1920（main=1682>1280）→ 收敛 w=1280 且居中 x=238+(1682-1280)/2=439；浅深主题完全一致。
  const layoutMenus = [
    ['概览', 'overview-ready'], ['模型组', 'combos-ready'], ['免费账号渠道', null],
    ['用量统计', 'usage-ready'], ['模型清单', 'models-ready'], ['API 接入', 'connection-ready'],
    ['服务设置', 'settings-ready'],
  ]
  const measureLayout = () => page.evaluate(() => {
    const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), width: +r.width.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2) } }
    const main = document.querySelector('main'), pageEl = document.querySelector('section.page')
    const cs = pageEl ? getComputedStyle(pageEl) : null, pad = cs ? parseFloat(cs.paddingLeft) : 0
    return {
      theme: document.documentElement.dataset.theme,
      mainDisplay: main ? getComputedStyle(main).display : null,
      innerHeight: window.innerHeight, scrollWidth: document.documentElement.scrollWidth,
      main: rect(main), page: rect(pageEl), footer: rect(document.querySelector('main > footer')),
      contentLeft: pageEl ? +(pageEl.getBoundingClientRect().x + pad).toFixed(2) : null,
      contentRight: pageEl ? +(pageEl.getBoundingClientRect().right - pad).toFixed(2) : null,
      notice: rect(document.querySelector('main > .notice')),
      connection: rect(document.querySelector('.connection-browser')), settings: rect(document.querySelector('.settings-browser')),
    }
  })
  const navTo = async (name, ready) => {
    await page.locator('.console-nav-item').filter({ hasText: name }).click()
    if (ready) await page.getByTestId(ready).waitFor()
    else if (name === '免费账号渠道') await page.getByLabel('搜索渠道').waitFor()
    await page.waitForTimeout(120)
  }
  const layout = {}
  for (const [vpName, viewport] of [['wide-1512', { width: 1512, height: 900 }], ['wide-1920', { width: 1920, height: 900 }]]) {
    await page.setViewportSize(viewport)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => { document.documentElement.dataset.theme = t; localStorage.setItem('ofm-theme', t) }, theme)
      await page.waitForTimeout(120)
      const entries = []
      for (const [name, ready] of layoutMenus) {
        await navTo(name, ready)
        const m = await measureLayout()
        assert.equal(m.theme, theme, `${vpName}/${theme}/${name} 主题应真正生效（dataset.theme）`)
        assert.equal(m.mainDisplay, 'flex', `${vpName}/${theme}/${name} main 计算值应为 flex`)
        assert.equal(m.page.width, Math.min(m.main.width, 1280), `${vpName}/${theme}/${name} 内容列宽应为 min(main,1280)`)
        assert.ok(Math.abs(m.page.x - (m.main.x + (m.main.width - m.page.width) / 2)) < 0.5, `${vpName}/${theme}/${name} 内容列应水平居中`)
        entries.push({ name, ...m })
      }
      layout[`${vpName}-${theme}`] = entries
      const xs = entries.map(e => e.page.x), ws = entries.map(e => e.page.width)
      assert.equal(new Set(xs).size, 1, `${vpName}/${theme} 七菜单 section.page 的 x 应唯一，实际 ${JSON.stringify(xs)}`)
      assert.equal(new Set(ws).size, 1, `${vpName}/${theme} 七菜单 section.page 的宽应唯一，实际 ${JSON.stringify(ws)}`)
      // 页脚落底：任何页面页脚都不得悬在视口中间（不得出现 >5px 的空档）
      for (const e of entries) assert.ok(e.innerHeight - e.footer.bottom < 5, `${vpName}/${theme}/${e.name} 页脚不得上浮，gap=${(e.innerHeight - e.footer.bottom).toFixed(2)}`)
      // 真·短页（本 fixture 下模型组不产生纵向滚动）：页脚必须贴视口底
      const short = entries.find(e => e.name === '模型组')
      assert.ok(short.innerHeight - short.footer.bottom < 5 && short.innerHeight - short.footer.bottom > -2, `${vpName}/${theme} 短页（模型组）页脚应贴视口底，gap=${(short.innerHeight - short.footer.bottom).toFixed(2)}`)
      // 窄栏（API 接入 / 服务设置）：≤900 且左右留白差 <2px（居中）
      for (const key of ['connection', 'settings']) {
        const owner = entries.find(e => e[key]); if (!owner) continue
        assert.ok(owner[key].width <= 900.5, `${vpName}/${theme}/${key} 宽度应 ≤900，实际 ${owner[key].width}`)
        const left = owner[key].x - owner.contentLeft, right = owner.contentRight - owner[key].right
        assert.ok(Math.abs(left - right) < 2, `${vpName}/${theme}/${key} 应在内容列内居中，左留白=${left.toFixed(2)} 右留白=${right.toFixed(2)}`)
      }
      // 通知条与内容列左右边界对齐
      const first = entries[0]
      if (first.notice) assert.ok(Math.abs(first.notice.x - first.contentLeft) < 2 && Math.abs(first.notice.right - first.contentRight) < 2, `${vpName}/${theme} 通知条应与内容列对齐`)
    }
    const light = layout[`${vpName}-light`], dark = layout[`${vpName}-dark`]
    assert.deepEqual(light.map(e => [e.page.x, e.page.width]), dark.map(e => [e.page.x, e.page.width]), `${vpName} 浅色与深色 section.page 位置/宽度应完全一致`)
    if (vpName === 'wide-1512') {
      assert.equal(light[0].page.x, 238, '视口 1512 内容列 x 应为 238')
      assert.equal(light[0].page.width, 1274, '视口 1512 内容列宽应为 1274')
    }
    if (vpName === 'wide-1920') {
      assert.equal(light[0].page.x, 439, '视口 1920 内容列应居中于 x=439')
      assert.equal(light[0].page.width, 1280, '视口 1920 内容列宽应收敛到 1280')
    }
  }
  // 窄断点不得横向溢出
  for (const [name, viewport] of [['≤700', { width: 700, height: 800 }], ['≤430', { width: 430, height: 800 }], ['≤320', { width: 320, height: 740 }]]) {
    await page.setViewportSize(viewport)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 不应横向溢出视口`)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  // ===== 用量页四档时间范围：控件 / 全页联动 / localStorage / 旧后端降级 =====
  await navTo('用量统计', 'usage-ready')
  const periodGroup = page.getByRole('group', { name: '统计时间范围' })
  await periodGroup.waitFor()
  for (const label of ['每日', '每周', '每月', '全部']) {
    assert.equal(await periodGroup.getByRole('button', { name: label, exact: true }).count(), 1, `档位按钮「${label}」应唯一`)
  }
  assert.equal(await periodGroup.getByRole('button', { name: '全部', exact: true }).getAttribute('aria-pressed'), 'true', '默认档位应为全部')
  assert.equal(await page.evaluate(() => localStorage.getItem('dsh-usage-period')), 'all')
  assert.equal(await page.getByRole('group', { name: '趋势时间范围' }).count(), 0, '7/14/30 天切换应已删除')
  assert.equal((await page.locator('[data-metric="用户回合"]').innerText()).trim(), '10', '全部档用户回合应为 lifetime 10')
  assert.equal((await page.locator('[data-testid="usage-request-failures"]').innerText()).trim(), '1', '全部档物理失败请求应为 1')
  await periodGroup.getByRole('button', { name: '每日', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-metric="用户回合"]')?.textContent?.trim() === '1')
  assert.equal(await page.evaluate(() => localStorage.getItem('dsh-usage-period')), 'day')
  assert.equal((await page.locator('[data-testid="usage-request-failures"]').innerText()).trim(), '0', '每日档物理失败请求应随档位联动为 0')
  assert.match(await page.getByTestId('usage-period-label').innerText(), /今日/)
  // 旧后端降级：periods 缺失 → 页面以累计口径渲染、不白屏
  legacyStats = true
  await page.reload()
  await page.getByTestId('overview-ready').waitFor()
  await navTo('用量统计', 'usage-ready')
  assert.equal((await page.locator('[data-metric="用户回合"]').innerText()).trim(), '10', 'periods 缺失时应回退累计口径')
  legacyStats = false
  await page.reload()
  await page.getByTestId('overview-ready').waitFor()
  await page.getByRole('button', { name: '退出管理', exact: true }).click()
  await page.getByTestId('login-screen').waitFor()
  assert.deepEqual(errors, [])
  console.log('react UI: 登录失败/成功、七页面导航、草稿保留/保存、密钥显隐/复制/轮换、轮询保持子页、三种视口、内容列宽度一致性/1280 收敛居中/两主题一致/页脚落底/窄栏居中、用量页四档联动与旧后端降级、退出通过')
} finally {
  await browser.close(); management.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
