/** Regression: the plugin's top navigation remains a readable horizontal strip. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadChromium } from './lib/playwright.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const standaloneRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
const chromium = loadChromium()
let esbuild
try { esbuild = standaloneRequire('esbuild') } catch {}
if (!chromium || !esbuild) {
  console.log('skip plugin-nav-layout-ui: requires Playwright Chromium and standalone esbuild/React dependencies')
  process.exit(0)
}

const react = await esbuild.build({
  stdin: {
    contents: "import * as React from 'react';import * as ReactDOM from 'react-dom';import{createRoot}from'react-dom/client';window.fixtureReact=React;window.fixtureReactDOM=ReactDOM;window.fixtureCreateRoot=createRoot;",
    resolveDir: fileURLToPath(new URL('../packages/standalone/', import.meta.url)),
  },
  bundle: true, write: false, format: 'iife', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--dsw-alias-label-primary:#24262c;--dsw-alias-label-secondary:#666975;--dsw-alias-label-tertiary:#8a8d98;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f7f8fa;--dsw-alias-bg-layer-3:#eef1f6;--dsw-alias-border-l1:#e5e7ed;--dsw-alias-border-l2:#d5d9e2;--dsw-alias-state-business-primary:#416fe8;--dsw-alias-state-success-primary:#249972;--dsw-alias-state-error-primary:#d94e62;color-scheme:light}
body{margin:0;padding:20px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);font:14px 'Segoe UI','Microsoft YaHei',sans-serif}#root{max-width:1080px;margin:auto;min-width:0}
@media(max-width:420px){body{padding:10px}}
</style></head><body><div id="root"></div><script src="/react.js"></script><script>
window.__ModuleLoader__={load:r=>window.plugin=r.factory(name=>name==='react-dom'?fixtureReactDOM:fixtureReact)};
</script><script src="/client.js"></script><script>
const {CSS,DICT,Shell}=plugin.__test;
document.head.append(Object.assign(document.createElement('style'),{textContent:CSS}));
const t=key=>DICT.zh[key]??key;t.locale='zh-CN';
const data={settings:{},catalog:[]};
fixtureCreateRoot(document.getElementById('root')).render(fixtureReact.createElement(Shell,{
  t,data,summary:{data,reload(){}},counts:{},stats:{reload(){}},ctx:{},eacLogin:{}
}));
</script></body></html>`

const server = http.createServer((req, res) => {
  const send = (value, type) => { res.writeHead(200, { 'content-type': type }); res.end(value) }
  if (req.url === '/') return send(html, 'text/html; charset=utf-8')
  if (req.url === '/react.js') return send(react.outputFiles[0].text, 'application/javascript')
  if (req.url === '/client.js') return send(fs.readFileSync(new URL('../client.js', import.meta.url)), 'application/javascript')
  if (req.url === '/favicon.ico') return send('', 'image/x-icon')
  res.writeHead(404); res.end()
})

let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 440, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.locator('.ofm_tabs [role=tab]').first().waitFor()
  assert.equal(await page.locator('.ofm_tabgroup, .ofm_tabgroupname').count(), 0)
  const layout = await page.locator('.ofm_tabs').evaluate(nav => {
    const tabs = [...nav.querySelectorAll('[role=tab]')]
    return {
      tabCount: tabs.length,
      tabsText: tabs.map(tab => tab.textContent.trim()),
      verticalText: tabs.filter(tab => {
        const style = getComputedStyle(tab)
        return style.writingMode !== 'horizontal-tb'
      }).map(tab => tab.textContent.trim()),
      overflow: nav.scrollWidth > nav.clientWidth + 1,
      outside: tabs.filter(tab => {
        const rect = tab.getBoundingClientRect(), box = nav.getBoundingClientRect()
        return rect.left < box.left - 1 || rect.right > box.right + 1
      }).map(tab => tab.textContent.trim()),
    }
  })
  assert.equal(layout.tabCount, 13)
  assert.deepEqual(layout.verticalText, [])
  assert.equal(layout.overflow, false)
  assert.deepEqual(layout.outside, [])
  for (const label of ['免费模型', '路由', '省 Token', 'EAC 模型', 'EAC router', '聚合渠道', '工作台', 'OFM 渠道扩展', '网关设置', '推荐项目', '数据看板', '运行日志', '插件升级']) {
    assert.ok(layout.tabsText.some(text => text.includes(label)), `missing navigation tab: ${label}`)
  }
  await page.setViewportSize({ width: 390, height: 900 })
  const mobile = await page.locator('.ofm_tabs').evaluate(nav => ({
    overflow: nav.scrollWidth > nav.clientWidth + 1,
    vertical: [...nav.querySelectorAll('[role=tab]')].some(tab => getComputedStyle(tab).writingMode !== 'horizontal-tb'),
  }))
  assert.deepEqual(mobile, { overflow: false, vertical: false })
  assert.deepEqual(errors, [])
  console.log(`plugin-nav-layout-ui: ${layout.tabCount}/13 tabs stay horizontal at 440 px and 390 px`)
} finally {
  await browser?.close()
  if (server.listening) await new Promise(resolve => server.close(resolve))
}
