/** Qoder catalog provenance only: source modules, real RPC and shared UI, no bundles/network. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'
import ts from 'typescript'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-qoder-catalog-'))
const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const savedFetch = globalThis.fetch
const savedStateDir = process.env.DSH_CHANNEL_PACK_STATE_DIR
const savedHome = process.env.DSH_HOME
let fetches = 0, credentialReads = 0, claims = 0
const cleanups = []
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        fileName: fileURLToPath(url), compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText }
    }
    return next(url, context)
  },
})
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
globalThis.fetch = async () => { fetches++; throw new Error('catalog tests forbid upstream requests') }

try {
  const { QoderAdapter, qoderDisplayName } = await import('../vendor/channel-pack/src/qoder-adapter.ts')
  const { QODER, QODER_CN, qoderCatalogInfo } = await import('../vendor/channel-pack/src/qoder-product.ts')
  const { registerChannelPackRpc } = await import('../vendor/channel-pack/src/channel-pack-rpc.ts')
  const { withDeadModelPruning } = await import('../vendor/channel-pack/src/dead-model-store.ts')
  const disabled = new Set(['qfmodel'])
  const pool = {
    disabledModelsFor: () => disabled,
    listDisabledModels: () => Object.fromEntries([...disabled].map(id => [id, true])),
    listAllAccounts: async () => [], listAccountsByProvider: () => [],
  }
  const adapters = new Map()
  for (const product of [QODER, QODER_CN]) {
    const before = JSON.stringify(product.fallbackModels)
    const adapter = new QoderAdapter({
      product, accountPool: pool, credentialRef: 'UNUSED_FIXTURE',
      resolveCredential: async () => { credentialReads++; throw new Error('listing must not read identity') },
      refresh: async () => { throw new Error('listing must not refresh identity') },
    })
    adapters.set(product.id, withDeadModelPruning([product.id], adapter))
    const all = adapter.listAllModels()
    assert.equal(all.length, product.fallbackModels.length)
    assert.equal(all.some(row => row.id === 'qfmodel'), true, 'hidden entries remain recoverable')
    const listed = await adapter.listModels(product.id)
    assert.equal(listed.some(row => row.id === 'qfmodel'), false, 'blacklist is still applied')
    for (const row of listed) {
      assert.ok(row.name.includes(product.catalogSnapshotDate))
      assert.ok(row.name.includes('快照'))
      assert.match(row.description, /不代表当前价格或实际扣费/)
      const metadata = await adapter.resolveModel(product.id, row.id)
      const original = product.fallbackModels.find(model => model.id === row.id)
      assert.equal(metadata.context.contextWindow, original.contextWindow)
      assert.deepEqual(metadata.inputModalities, original.supportsImage ? ['text', 'image'] : ['text'])
      assert.equal(metadata.name, row.name, 'selector and resolved name share the same snapshot label')
      if (original.defaultEffort) assert.equal(metadata.reasoning.defaultEffort, original.defaultEffort)
    }
    const historicFree = all.find(row => row.id === 'qfmodel')
    assert.match(historicFree.name, /快照 x0/)
    assert.doesNotMatch(historicFree.name, /免费/, 'historical x0 cannot promise current free use')
    const promo = product.fallbackModels.find(model => model.id === 'qmodel_38max')
    assert.ok(qoderDisplayName(promo, product.catalogSnapshotDate).includes(`x${promo.priceFactor}`))
    assert.doesNotMatch(qoderDisplayName(promo), /→/, 'never project an old discount into today')
    assert.equal(JSON.stringify(product.fallbackModels), before, 'full fallback metadata is preserved')
    const provenance = qoderCatalogInfo(product)
    assert.deepEqual(provenance, { source: 'static-snapshot', snapshotDate: product.catalogSnapshotDate,
      pricing: 'reference-only', refreshSupported: false, refreshUnavailableReason: 'missing-authorized-catalog-contract' })
    provenance.snapshotDate = 'not-persisted'
    assert.equal(qoderCatalogInfo(product).snapshotDate, product.catalogSnapshotDate)
  }
  assert.equal(QODER.catalogSnapshotDate, '2026-09-21')
  assert.equal(QODER_CN.catalogSnapshotDate, '2026-09-27')
  assert.equal(qoderDisplayName({ id: 'unknown', name: 'Unknown', contextWindow: 200_000 }), 'Unknown · 快照（仅参考）',
    'missing prices remain unknown rather than zero/free')
  assert.equal(adapters.get('qoder').listAllModels().some(row => row.id === 'smodel'), true)
  assert.equal(adapters.get('qodercn').listAllModels().some(row => row.id === 'smodel'), false, 'regional catalogs remain separate')

  const routes = []
  const auth = { claimDailyQuota: async () => { claims++; throw new Error('listing must not claim') } }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    connection: { fetch: { register: route => routes.push(route) } },
    llm: { listModels: async provider => adapters.get(provider)?.listModels(provider) ?? [{ id: 'other', name: 'Other' }] },
    credentials: { resolve: async () => { credentialReads++; throw new Error('catalog RPC must not read credentials') } },
    get(name) { return this[name] },
    inject(_names, callback) { callback(this) },
    effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
  }
  registerChannelPackRpc(ctx, pool, auth, auth, auth, auth, auth, auth, auth, auth, auth, auth,
    Object.fromEntries(adapters), { disableOpencode: true })
  const route = routes.find(item => item.path === '/api/channel-pack')
  assert.ok(route)
  const call = async (method, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'channel-pack', payload: { method, payload } }),
    }))
    return (await response.json()).result
  }
  for (const product of [QODER, QODER_CN]) {
    const result = await call('model.list', { provider: product.id })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.catalog, qoderCatalogInfo(product), 'registered RPC exposes source and collection date')
    assert.equal(result.value.models.find(model => model.id === 'qfmodel').disabled, true)
    assert.equal((await call('model.refresh', { provider: product.id })).ok, false, 'unsupported refresh cannot report success')
  }
  assert.equal((await call('model.list', { provider: 'lobsterai' })).value.catalog, undefined)
  assert.deepEqual({ fetches, credentialReads, claims }, { fetches: 0, credentialReads: 0, claims: 0 })
  console.log('ok Qoder source/RPC: dated snapshots, no current-free promises or projected promos, metadata and regional/hidden models preserved, zero network/identity/claims')

  await verifyUi()
} finally {
  for (const cleanup of cleanups.reverse()) cleanup()
  hooks.deregister()
  globalThis.fetch = savedFetch
  for (const [name, value] of [['DSH_HOME', savedHome], ['DSH_CHANNEL_PACK_STATE_DIR', savedStateDir]]) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(scratch, { recursive: true, force: true })
}

async function verifyUi() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .replace('exports.__test = {', 'exports.__test = { ChannelCard,')
  const settle = () => new Promise(resolve => setImmediate(resolve))
  function mount(provider, locale = 'zh') {
    let bundle, cursor = 0, release
    const cells = [], calls = [], resolutions = []
    const window = { __ModuleLoader__: { load: value => { bundle = value } } }
    new Function('window', source)(window)
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment',
      useState(initial) {
        const index = cursor++
        if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
        return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
      },
      useRef(initial) { return cells[cursor++] ??= { current: initial } },
      useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
    }
    const { ChannelCard, DICT } = bundle.factory(() => react).__test
    const props = { channel: { id: provider, name: provider }, status: { accounts: { total: 0, enabled: 0 } },
      t: key => DICT[locale][key], onChanged() {}, onError(_channel, error) { throw error },
      rpc: async (method, payload) => {
        calls.push({ method, payload })
        assert.equal(method, 'model.list', 'opening models must never claim or infer')
        return new Promise(resolve => { release = resolve; resolutions.push(resolve) })
      },
    }
    const render = () => { cursor = 0; return ChannelCard(props) }
    const nodes = () => {
      const result = []
      const visit = node => {
        if (Array.isArray(node)) return node.forEach(visit)
        if (!node || typeof node !== 'object') return
        result.push(node); visit(node.children)
      }
      visit(render()); return result
    }
    const button = label => nodes().find(node => node.type === 'button' && node.children.includes(label))
    const text = () => JSON.stringify(render())
    return { props, cells, calls, resolutions, button, text, release: value => release(value) }
  }
  for (const [provider, date] of [['qoder', '2026-09-21'], ['qodercn', '2026-09-27']]) {
    for (const locale of ['zh', 'en']) {
      const app = mount(provider, locale)
      assert.ok(app.text().includes(date), 'collection date is visible even with an older backend')
      assert.ok(app.text().includes(locale === 'zh' ? '不代表当前价格或实际扣费' : 'not current prices or actual charges'))
      app.button(locale === 'zh' ? '模型' : 'Models').props.onClick()
      app.release({ models: [{ id: 'qfmodel', name: 'Qwen3.8-Flash · 免费', isFree: true }] })
      await settle()
      assert.ok(app.text().includes(locale === 'zh' ? '远端目录刷新暂不可用' : 'Remote catalog refresh is unavailable'))
      assert.ok(app.text().includes(locale === 'zh' ? '快照参考：Qwen3.8-Flash' : 'Snapshot reference: Qwen3.8-Flash'))
      assert.ok(!app.text().includes('"ofm_tagpill free"'), 'old backend free metadata cannot become a current-free badge')
      assert.deepEqual(app.calls.map(call => call.method), ['model.list'])
    }
  }
  const app = mount('qoder')
  app.button('模型').props.onClick()
  const pending = app.release
  app.props.channel = { id: 'qodercn', name: 'qodercn' }
  assert.ok(app.text().includes('2026-09-27'))
  pending({ catalog: { source: 'static-snapshot', snapshotDate: '2026-09-21' }, models: [{ id: 'wrong-region', name: 'Stale' }] })
  await settle()
  assert.equal(app.cells[2], undefined, 'a previous provider request cannot overwrite the next provider catalog')
  assert.ok(!app.text().includes('2026-09-21'))
  const transport = mount('qoder')
  transport.button('模型').props.onClick()
  const oldReply = transport.resolutions[0]
  transport.props.rpc = async () => ({ models: [{ id: 'current', name: 'Current transport' }] })
  transport.text()
  transport.button('模型').props.onClick()
  transport.button('模型').props.onClick()
  await settle()
  oldReply({ models: [{ id: 'wrong-transport', name: 'Stale transport' }] })
  await settle()
  assert.equal(transport.cells[2][0].id, 'current', 'a replaced host transport cannot overwrite the active catalog')
  const other = mount('lobsterai')
  assert.ok(!other.text().includes('static-snapshot'), 'unrelated channels retain their current presentation')
  console.log('ok Qoder shared UI: zh/en snapshot/date/actual-charge notices, old-backend fallback, no live-free badge, provider/transport races rejected')
}
