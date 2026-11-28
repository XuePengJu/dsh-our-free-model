/** Real React/Chromium with synthetic data; no Host profile or engine process. */
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
  test('client async/locale browser regressions', { skip: 'requires Playwright Chromium and standalone esbuild/React dependencies' }, () => {})
} else {
  const react = await esbuild.build({
    stdin: {
      contents: "import * as React from 'react';import * as ReactDOM from 'react-dom';import {createRoot} from 'react-dom/client';window.fixtureReact=React;window.fixtureReactDOM=ReactDOM;window.fixtureCreateRoot=createRoot;",
      resolveDir: fileURLToPath(new URL('../packages/standalone/', import.meta.url)),
    }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"development"' },
  })
  const original = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const client = original.replace('exports.__test = {', 'exports.__test = { useAsync, ModelWorkspace, ChannelCard, CHANNEL_PROVIDERS, ChainEditor, RoutingPage,')
  assert.notEqual(client, original)
  const origin = 'http://127.0.0.1:41983'
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div>
<script src="/react.js"></script><script>
const React = window.fixtureReact, h = React.createElement;
window.fixture = { mounted: true, writesAfterUnmount: 0, pending: [], intervals: new Set(), listeners: new Set(), comboWrites: [], comboMode: 'ok' };
const setIntervalOriginal = window.setInterval, clearIntervalOriginal = window.clearInterval;
window.setInterval = (...args) => { const id = setIntervalOriginal(...args); fixture.intervals.add(id); return id; };
window.clearInterval = id => { fixture.intervals.delete(id); clearIntervalOriginal(id); };
const add = window.addEventListener, remove = window.removeEventListener;
window.addEventListener = function(type, fn, ...args) { if (type === 'message') fixture.listeners.add(fn); return add.call(this, type, fn, ...args); };
window.removeEventListener = function(type, fn, ...args) { if (type === 'message') fixture.listeners.delete(fn); return remove.call(this, type, fn, ...args); };
window.__ModuleLoader__ = { load: record => {
  const trackedReact = { ...React, useState(initial) {
    const [value, set] = React.useState(initial);
    return [value, next => { if (!fixture.mounted) fixture.writesAfterUnmount++; set(next); }];
  } };
  window.plugin = record.factory(name => name === 'react-dom' ? fixtureReactDOM : trackedReact);
} };
</script><script src="/client.js"></script><script>
const { useAsync, ModelWorkspace, ChannelCard, CHANNEL_PROVIDERS, ChainEditor, RoutingPage, DICT, CSS } = plugin.__test;
document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
fixture.recordsBefore = JSON.stringify(CHANNEL_PROVIDERS);
localStorage.setItem('ofm:zcode:login-provider', 'zai');
localStorage.setItem('external-explicit-language', 'zh');
fixture.storageBefore = JSON.stringify(Object.entries(localStorage));
const mode = new URL(location.href).searchParams.get('mode');
const loader = () => new Promise((resolve, reject) => fixture.pending.push({ resolve, reject }));
const models = [], chain = { name: 'Original', models: [] }, summary = { reload() {} };
function AsyncView() {
  const state = useAsync(loader, []);
  fixture.reload = state.reload;
  return h('section', null, h('button', { onClick: state.reload }, 'Reload fixture'),
    h('output', { id: 'snapshot' }, JSON.stringify(state)));
}
function App() {
  const [language, setLanguage] = React.useState('en');
  fixture.language = setLanguage;
  const t = Object.assign(key => DICT[language][key], { locale: language });
  return h('main', { className: 'ofm_root' },
    mode === 'async' ? h(AsyncView) : mode === 'workspace' ? h(ModelWorkspace, { t, summary })
      : mode === 'routing' ? h(RoutingPage, { t })
      : h(React.Fragment, null,
        h('section', { id: 'channels' }, CHANNEL_PROVIDERS.map(channel => h(ChannelCard, { key: channel.id, channel, t, compact: true, rpc: null }))),
        h('section', { id: 'draft' }, h(ChainEditor, { t, chain, models, onSave() {}, onCancel() {} }))));
}
const root = fixtureCreateRoot(document.getElementById('root'));
fixture.unmount = () => { root.unmount(); fixture.mounted = false; };
root.render(h(App));
</script></body></html>`
  const browser = await chromium.launch({ headless: true,
    ...(process.env.OFM_BROWSER_EXECUTABLE ? { executablePath: process.env.OFM_BROWSER_EXECUTABLE } : {}) })
  const open = async (check, mode, deferStart = false) => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
    check.after(() => page.close())
    const errors = [], unexpected = [], requests = [], downloads = []
    let startRequested
    const start = new Promise(resolve => { startRequested = resolve })
    const failStart = route => route.fulfill({ status: 503, json: { error: 'Synthetic raw diagnostic 原因 <detail>' } })
    page.on('download', download => downloads.push(download))
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html })
        if (url.pathname === '/react.js') return route.fulfill({ contentType: 'text/javascript', body: react.outputFiles[0].text })
        if (url.pathname === '/client.js') return route.fulfill({ contentType: 'text/javascript', body: client })
        if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 })
        if (mode === 'workspace' && url.pathname === '/api/our-free-model/engine/start') {
          requests.push(url.pathname)
          startRequested(route)
          if (!deferStart) return failStart(route)
          return
        }
        if (mode === 'routing' && url.pathname === '/api/our-free-model/combos' && route.request().method() === 'GET') {
          requests.push(url.pathname)
          return route.fulfill({ json: {
            combos: [{ id: 'combo:existing', name: 'Existing', models: ['model-a'], strategy: 'fallback', stickyLimit: 1, enabled: true }],
            models: [{ id: 'model-a', name: 'Model A', channel: 'free' }],
            usable: [{ id: 'combo:existing', models: ['model-a'] }],
            strategies: ['fallback', 'round-robin'],
          } })
        }
        if (mode === 'routing' && url.pathname === '/api/our-free-model/combos' && route.request().method() === 'POST') {
          const body = JSON.parse(route.request().postData() ?? '{}')
          await page.evaluate(value => fixture.comboWrites.push(value), body)
          if (await page.evaluate(() => fixture.comboMode) === 'fail') {
            return route.fulfill({ status: 400, json: { error: 'Synthetic import refusal' } })
          }
          return route.fulfill({ json: {
            ok: true, combos: body.combos, usable: body.combos.map(row => ({ id: row.id, models: row.models })),
          } })
        }
      }
      unexpected.push(url.href)
      await route.abort()
    })
    await page.goto(`${origin}/?mode=${mode}`)
    page.setDefaultTimeout(10000)
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const verify = async () => {
      assert.deepEqual(errors, [])
      assert.deepEqual(unexpected, [])
      assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage))), await page.evaluate(() => fixture.storageBefore))
    }
    return { page, settle, verify, requests, downloads, failStart: async () => failStart(await start) }
  }
  try {
    await test('rendered reloads keep the latest response and dispose pending manual reloads', { timeout: 30000 }, async check => {
      const { page, settle, verify } = await open(check, 'async')
      await page.waitForFunction(() => fixture.pending.length === 1)
      await page.evaluate(() => fixture.pending[0].resolve({ revision: 1 })); await settle()
      await page.getByRole('button', { name: 'Reload fixture' }).click()
      await page.getByRole('button', { name: 'Reload fixture' }).click()
      await page.evaluate(() => fixture.pending[2].resolve({ revision: 3, enabled: true })); await settle()
      await page.evaluate(() => fixture.pending[1].resolve({ revision: 2, enabled: false })); await settle()
      assert.deepEqual(JSON.parse(await page.locator('#snapshot').innerText()).data, { revision: 3, enabled: true })
      await page.getByRole('button', { name: 'Reload fixture' }).click()
      await page.evaluate(() => fixture.unmount())
      await page.evaluate(async () => { fixture.pending[3].reject(new Error('late rejection')); await fixture.reload() }); await settle()
      assert.deepEqual(await page.evaluate(() => ({ pending: fixture.pending.length, writes: fixture.writesAfterUnmount })), { pending: 4, writes: 0 })
      await verify()
    })
    for (const switchWhilePending of [false, true]) {
      await test(`rendered workspace errors translate and release listeners (switch while pending: ${switchWhilePending})`, { timeout: 30000 }, async check => {
        const { page, settle, verify, requests, failStart } = await open(check, 'workspace', switchWhilePending)
        if (switchWhilePending) {
          await page.getByRole('status').waitFor()
          await page.evaluate(() => fixture.language('zh')); await settle()
          await failStart()
        }
        await page.getByRole('alert').waitFor()
        assert.ok((await page.getByRole('alert').innerText()).includes(switchWhilePending ? '工作台启动失败' : 'Workspace could not start'))
        for (const language of ['zh', 'en']) {
          await page.evaluate(value => fixture.language(value), language); await settle()
          assert.ok((await page.getByRole('alert').innerText()).includes(language === 'zh' ? '工作台启动失败' : 'Workspace could not start'))
          assert.ok((await page.getByRole('alert').innerText()).includes('Synthetic raw diagnostic 原因 <detail>'))
        }
        assert.equal(requests.length, 1)
        assert.equal(await page.evaluate(() => fixture.listeners.size), 1)
        await page.evaluate(() => fixture.unmount())
        assert.equal(await page.evaluate(() => fixture.listeners.size), 0)
        await verify()
      })
    }
    await test('rendered channel translations preserve descriptors, preferences and an unsaved editor', { timeout: 30000 }, async check => {
      const { page, settle, verify } = await open(check, 'channels')
      await page.locator('#channels [data-channel]').first().waitFor()
      const draft = page.locator('#draft input').first()
      await draft.fill('Unsaved user text 用户内容')
      for (const language of ['en', 'zh', 'en']) {
        await page.evaluate(value => fixture.language(value), language); await settle()
        assert.equal(await draft.inputValue(), 'Unsaved user text 用户内容')
        const channels = await page.locator('#channels').innerText()
        for (const label of language === 'en' ? ['Youdao', 'Alibaba', 'ByteDance', 'iFlytek', 'SenseTime', 'Zhipu', 'Qoder China']
          : ['有道', '阿里系', '字节', '讯飞', '商汤', '智谱', 'Qoder 中国版']) assert.ok(channels.includes(label), label)
        assert.equal(await page.locator('#channels [data-channel]').count(), 10)
      }
      assert.equal(await page.evaluate(() => JSON.stringify(plugin.__test.CHANNEL_PROVIDERS)), await page.evaluate(() => fixture.recordsBefore))
      assert.ok(await page.evaluate(() => fixture.intervals.size > 0))
      await page.evaluate(() => fixture.unmount())
      assert.equal(await page.evaluate(() => fixture.intervals.size), 0)
      await verify()
    })
    await test('rendered combo JSON export and import stay scoped, validated and replace-only', { timeout: 30000 }, async check => {
      const { page, settle, verify, requests, downloads } = await open(check, 'routing')
      await page.getByText('Existing', { exact: true }).waitFor()
      assert.match(await page.locator('main').innerText(), /contains only chain definitions/)
      assert.equal(requests.filter(path => path.endsWith('/combos')).length, 1)

      const downloadPromise = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Export JSON' }).click()
      const download = await downloadPromise
      assert.match(download.suggestedFilename(), /^ofm-combos-\d{4}-\d{2}-\d{2}\.json$/)
      const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'))
      assert.deepEqual(exported, {
        format: 'ofm-combos/v1',
        combos: [{ id: 'combo:existing', name: 'Existing', models: ['model-a'], strategy: 'fallback', stickyLimit: 1, enabled: true }],
      })
      assert.equal(downloads.length, 1)

      const chooser = page.locator('input[type=file]')
      await chooser.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"secret":"do-not-use","combos":"wrong"}') })
      await page.getByRole('alert').waitFor()
      assert.match(await page.getByRole('alert').innerText(), /does not match the required shape/)
      assert.equal(await page.evaluate(() => fixture.comboWrites.length), 0)

      page.once('dialog', dialog => dialog.dismiss())
      await chooser.setInputFiles({ name: 'cancelled.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
        format: 'ofm-combos/v1', secret: 'must-not-be-sent',
        combos: [{ name: 'Cancelled', models: ['model-a'], strategy: 'fallback' }],
      })) })
      await settle()
      assert.equal(await page.evaluate(() => fixture.comboWrites.length), 0)

      page.once('dialog', async dialog => {
        assert.match(dialog.message(), /replace all 1 current chain/)
        assert.match(dialog.message(), /Accounts, secrets and other settings are not changed/)
        await dialog.accept()
      })
      await chooser.setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
        format: 'ofm-combos/v1', secret: 'must-not-be-sent',
        combos: [{ name: 'Imported', models: ['model-a'], strategy: 'round-robin', stickyLimit: 2, enabled: true }],
      })) })
      await page.getByText(/Imported 1 chain/).waitFor()
      assert.deepEqual(await page.evaluate(() => fixture.comboWrites[0]), {
        combos: [{ name: 'Imported', models: ['model-a'], strategy: 'round-robin', stickyLimit: 2, enabled: true }],
      })
      assert.doesNotMatch(JSON.stringify(await page.evaluate(() => fixture.comboWrites)), /must-not-be-sent|secret/)

      await page.evaluate(() => { fixture.comboMode = 'fail' })
      page.once('dialog', dialog => dialog.accept())
      await chooser.setInputFiles({ name: 'server-failure.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
        format: 'ofm-combos/v1', combos: [{ name: 'Rejected', models: ['model-a'], strategy: 'fallback' }],
      })) })
      await page.getByRole('alert').waitFor()
      assert.match(await page.getByRole('alert').innerText(), /Synthetic import refusal/)
      assert.equal(await page.evaluate(() => fixture.comboWrites.length), 2)
      await verify()
    })
    console.log(`client-async-locale-ui: Chromium ${browser.version()}, React ${require('react/package.json').version}; synthetic fixtures only`)
  } finally { await browser.close() }
}
