/** Real React/Chromium regression for #724; only synthetic in-memory drafts. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadChromium } from './lib/playwright.mjs'

const chromium = loadChromium()
const require = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
let esbuild
try { esbuild = require('esbuild') } catch {}
if (!chromium || !esbuild) {
  test('workbench iframe and dialog state', { skip: 'requires Playwright Chromium and standalone esbuild/React dependencies' }, () => {})
} else {
  const fixture = await esbuild.build({
    stdin: {
      contents: `import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Workspace } from './workspace';
import { WorkbenchDialog } from './components/workbench-dialog';
import { Button, Input } from './components/ui';
import './system/tokens.css';
import './system/shell.css';
import './system/motion.css';
import './workbench.css';
window.fixtureReact = React; window.fixtureReactDOM = ReactDOM; window.fixtureCreateRoot = createRoot;
function Editor() {
  const [name, setName] = React.useState('Fixture provider');
  const [secret, setSecret] = React.useState('');
  return <WorkbenchDialog title="Fixture provider settings" onClose={() => { window.fixtureCloses = (window.fixtureCloses || 0) + 1 }}>
    <form className="wb-form" onSubmit={event => { event.preventDefault(); window.fixtureSaves = (window.fixtureSaves || 0) + 1 }}>
      <label>Provider name<Input id="fixture-name" value={name} onChange={event => setName(event.target.value)} /></label>
      <label>API key<Input id="fixture-secret" type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} /></label>
      {Array.from({ length: 9 }, (_, index) => <label key={index}>Fixture option {index + 1}<Input defaultValue={'Option ' + (index + 1)} /></label>)}
      <div className="wb-form-actions"><Button variant="outline">Test fixture</Button><Button id="fixture-save" type="submit">Save fixture</Button></div>
    </form>
  </WorkbenchDialog>;
}
window.fixtureMountEditor = () => createRoot(document.getElementById('root')).render(<Editor />);
window.fixtureMountStandalone = () => { const root = createRoot(document.getElementById('root')); window.fixtureUnmount = () => root.unmount(); root.render(<Workspace active />); };`,
      loader: 'tsx', resolveDir: fileURLToPath(new URL('../packages/standalone/frontend/', import.meta.url)),
    },
    bundle: true, write: false, outdir: 'fixture', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
  })
  const script = fixture.outputFiles.find(file => file.path.endsWith('.js')).text
  const css = fixture.outputFiles.find(file => file.path.endsWith('.css')).text
  const original = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const client = original.replace('exports.__test = {', 'exports.__test = { ModelWorkspace,')
  assert.notEqual(client, original)
  const origin = 'http://127.0.0.1:41984'
  const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css">'
  const editor = `<!doctype html><html><head>${head}</head><body><div id="root"></div><script src="/fixture.js"></script><script>fixtureMountEditor()</script></body></html>`
  const html = mode => `<!doctype html><html><head>${head}<style>
.fixture-sticky{position:fixed;inset:0 0 auto;height:72px;z-index:2147483647;background:#555;color:white}
.fixture-host{margin:88px 20px 20px;transform:translateZ(0)}
</style></head><body><header class="fixture-sticky"><button id="fixture-outside">Synthetic host action</button></header><div id="root" class="fixture-host"></div>
<script>localStorage.setItem('fixture-preference','keep');window.fixtureStorageBefore=JSON.stringify(Object.entries(localStorage));</script>
<script src="/fixture.js"></script>
${mode === 'client' ? `<script>window.__ModuleLoader__={load:record=>window.plugin=record.factory(name=>name==='react-dom'?fixtureReactDOM:fixtureReact)}</script><script src="/client.js"></script><script>
const {ModelWorkspace,DICT,CSS}=plugin.__test;document.head.append(Object.assign(document.createElement('style'),{textContent:CSS}));
const t=Object.assign(key=>DICT.en[key],{locale:'en'});
const root=fixtureCreateRoot(document.getElementById('root'));window.fixtureUnmount=()=>root.unmount();root.render(fixtureReact.createElement('main',{className:'ofm_root ofm_shell'},fixtureReact.createElement(ModelWorkspace,{t,summary:{reload(){}}})))
</script>` : '<script>fixtureMountStandalone()</script>'}</body></html>`

  const browser = await chromium.launch({ headless: true,
    ...(process.env.OFM_BROWSER_EXECUTABLE ? { executablePath: process.env.OFM_BROWSER_EXECUTABLE } : {}) })
  const open = async (check, mode, viewport = { width: 1000, height: 480 }) => {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    check.after(() => page.close())
    page.setDefaultTimeout(5000)
    const errors = [], unexpected = [], loads = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: mode === 'dialog' ? editor : html(mode) })
        if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script })
        if (url.pathname === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: css })
        if (url.pathname === '/client.js') return route.fulfill({ contentType: 'text/javascript', body: client })
        if (/\/engine\/start$/.test(url.pathname)) return route.fulfill({ json: { ok: true } })
        if (/\/engine\/ui\/$/.test(url.pathname)) { loads.push(url.pathname); return route.fulfill({ contentType: 'text/html', body: editor }) }
        if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 })
      }
      unexpected.push(url.href); await route.abort()
    })
    await page.goto(origin)
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const verify = async () => {
      assert.deepEqual(errors, [], 'no browser exceptions')
      assert.deepEqual(unexpected, [], 'synthetic fixture must not contact external services')
      if (mode !== 'dialog') assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage))), await page.evaluate(() => fixtureStorageBefore), 'unsaved credentials must never be persisted')
    }
    return { page, settle, verify, loads }
  }
  const assertSaveReachable = async (page, frame, expected) => {
    const save = frame.locator('#fixture-save')
    if (frame !== page) await page.locator('iframe').scrollIntoViewIfNeeded()
    await save.scrollIntoViewIfNeeded()
    const bounds = await save.evaluate(button => {
      const rect = button.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, height: innerHeight, hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === button }
    })
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height && bounds.hit, `Save must be visible inside the dialog: ${JSON.stringify(bounds)}`)
    await save.click()
    await frame.locator('body').evaluate(() => { if (!window.fixtureSaves) throw new Error('Save was not activated') })
    assert.equal(await frame.locator('body').evaluate(() => window.fixtureSaves), expected)
    await frame.locator('#fixture-name').focus()
    let reached = false
    for (let index = 0; index < 16; index++) {
      await page.keyboard.press('Tab')
      if (await save.evaluate(button => document.activeElement === button)) { reached = true; break }
    }
    assert.ok(reached, 'Tab must reach Save from the first field')
    await page.keyboard.press('Enter')
    assert.equal(await frame.locator('body').evaluate(() => window.fixtureSaves), expected + 1)
  }
  try {
    for (const mode of ['client', 'standalone']) for (const height of [480, 280, 200]) {
      await test(`${mode} fullscreen retains iframe and unsaved form with usable Save at ${height}px height`, { timeout: 45000 }, async check => {
        const { page, settle, verify, loads } = await open(check, mode, { width: 1000, height })
        const frame = page.frameLocator('iframe')
        await frame.locator('#fixture-secret').fill('unsaved synthetic secret')
        await frame.locator('#fixture-name').fill('Unsaved provider 用户草稿')
        await page.evaluate(() => {
          const frame = document.querySelector('iframe')
          window.fixtureIdentity = { frame, window: frame.contentWindow, document: frame.contentDocument }
        })
        await assertSaveReachable(page, frame, 1)
        const toggle = () => page.locator(mode === 'client' ? '.ofm_enginetools button' : '.ws-tools button').first()
        for (let cycle = 0; cycle < 2; cycle++) {
          for (const expanded of [true, false]) {
            await toggle().click(); await settle()
            const state = await page.evaluate(() => {
              const current = document.querySelector('iframe'), previous = window.fixtureIdentity
              return { frame: current === previous.frame, window: current?.contentWindow === previous.window, document: current?.contentDocument === previous.document }
            })
            assert.deepEqual(state, { frame: true, window: true, document: true }, 'fullscreen must not remount or move the iframe browsing context')
            assert.equal(await frame.locator('#fixture-secret').inputValue(), 'unsaved synthetic secret')
            assert.equal(await frame.locator('#fixture-name').inputValue(), 'Unsaved provider 用户草稿')
            assert.equal(loads.length, 1, 'fullscreen must not navigate the iframe')
            if (expanded) {
              const bounds = await toggle().evaluate(button => {
                const rect = button.getBoundingClientRect()
                return { top: rect.top, bottom: rect.bottom, height: innerHeight, hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === button }
              })
              assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height && bounds.hit, `fullscreen toolbar must escape transformed containers and the sticky header: ${JSON.stringify(bounds)}`)
              assert.equal(await page.evaluate(() => { document.getElementById('fixture-outside').focus(); return document.activeElement?.id === 'fixture-outside' }), false, 'the fullscreen dialog must keep the background inert')
              await frame.locator('#fixture-name').press('Escape'); await settle()
              assert.equal(await page.locator(mode === 'client' ? '.ofm_engineoverlay' : '.ws-page.is-expanded').count(), 1, 'Escape belongs to the iframe editor while it has an open dialog')
            }
            await assertSaveReachable(page, frame, 3 + cycle * 4 + (expanded ? 0 : 2))
          }
        }
        await toggle().click(); await settle()
        await toggle().focus(); await page.keyboard.press('Escape'); await settle()
        assert.equal(await page.locator(mode === 'client' ? '.ofm_engineoverlay' : '.ws-page.is-expanded').count(), 0, 'Escape from the fullscreen toolbar must collapse the workspace')
        assert.equal(await toggle().evaluate(button => document.activeElement === button), true, 'collapse restores focus to its trigger')
        await toggle().click(); await settle()
        await frame.locator('body').evaluate(body => { document.querySelector('dialog').close(); body.tabIndex = -1; body.focus() })
        await page.keyboard.press('Escape'); await settle()
        assert.equal(await page.locator(mode === 'client' ? '.ofm_engineoverlay' : '.ws-page.is-expanded').count(), 0, 'Escape from the iframe collapses the workspace when no child dialog owns it')
        await toggle().click(); await settle()
        await page.evaluate(() => fixtureUnmount()); await settle()
        assert.equal(await page.locator('iframe,dialog').count(), 0, 'unmount removes the frame and top-layer dialog')
        await page.locator('#fixture-outside').click()
        await verify()
      })
    }
    for (const height of [480, 280, 200]) {
      await test(`WorkbenchDialog Save is clickable and keyboard reachable at ${height}px height`, { timeout: 20000 }, async check => {
        const { page, verify } = await open(check, 'dialog', { width: 390, height })
        await page.locator('#fixture-secret').fill('draft stays in memory')
        await assertSaveReachable(page, page, 1)
        await verify()
      })
    }
    console.log(`workbench-dialog-state: Chromium ${browser.version()}, React ${require('react/package.json').version}; synthetic drafts, no engine processes or live credentials`)
  } finally { await browser.close() }
}
