/** Offline account-channel catalog/combo bridge: no real credentials or upstreams. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ACCOUNT_CHANNEL_PROVIDERS, accountChannelCatalog, createAccountChannelBridge } from '../src/adapter.js'
import { createModelRuntime, createRuntimeStores } from '../src/core/runtime.js'
import { startForwardServer } from '../src/forward.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-account-routing-'))
const logger = { warn() {}, info() {} }
const stores = []
const runtimes = []
const models = [
  { id: 'qoder/model-a', name: 'A', context_window: 200000, max_tokens: 32000, vision: true },
  { id: 'raccoon/model-b', name: 'B', context_window: 128000, max_tokens: 16000, vision: true },
]
const input = (model = 'combo:accounts', signal) => ({
  provider: 'our-free-model', model, signal, sessionId: 'fixture-session',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
})
const collect = async iterator => {
  const chunks = []
  while (true) {
    const next = await iterator.next()
    if (next.done) return { chunks, result: next.value }
    chunks.push(next.value)
  }
}
const success = emit => {
  emit({ type: 'block-start', index: 0, blockType: 'text' })
  emit({ type: 'text-delta', index: 0, text: 'account answer' })
  emit({ type: 'block-end', index: 0, block: { type: 'text', text: 'account answer' } })
  emit({ type: 'usage', usage: { inputTokens: 7, outputTokens: 4 } })
  emit({ type: 'finish', reason: { kind: 'stop' } })
}
const setup = complete => {
  let rows = models
  const store = createRuntimeStores({ dataDir: path.join(scratch, crypto.randomUUID()), logger })
  stores.push(store)
  store.settings.update({ combos: [{ id: 'combo:accounts', name: 'accounts', models: models.map(row => `account:${row.id}`) }] })
  const runtime = createModelRuntime({ ...store, logger, accountChannelRuntime: { catalog: () => rows, complete } })
  runtimes.push(runtime)
  return { ...store, runtime, setRows(next) { rows = next; runtime.syncAggregateCatalog() } }
}

let server
try {
  const projected = accountChannelCatalog({
    catalog: () => [...models, { id: 'buddy/removed' }, { id: 'codearts/removed' }, { id: 'our-free-model/recursive' }].map(row => ({ ...row, access_token: 'never-copy' })),
    complete() {},
  })
  assert.deepEqual(projected.map(row => row.id), models.map(row => `account:${row.id}`))
  assert.equal(projected[0].contextWindow, 200000)
  assert.equal(projected[0].vision, true)
  assert.ok(projected.every(row => !Object.hasOwn(row, 'access_token')))
  assert.equal(ACCOUNT_CHANNEL_PROVIDERS.length, 10)
  console.log('ok account metadata is whitelisted, capability-preserving and credential-free')

  let listed = [], dispatched
  const host = createAccountChannelBridge({
    listModels: async provider => { listed.push(provider); return provider === 'qoder' ? [{ id: 'model-a', name: 'A', inputModalities: ['text', 'image'] }] : [] },
    resolveModelInfo: async () => ({ context: { contextWindow: 200000 }, defaultMaxTokens: 32000 }),
    async *stream(options) { dispatched = options; yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  await host.refresh()
  assert.deepEqual(listed, ACCOUNT_CHANNEL_PROVIDERS)
  await host.complete(input('qoder/model-a'), () => {})
  assert.equal(dispatched.provider, 'qoder')
  assert.equal(dispatched.model, 'model-a')
  assert.equal(dispatched.sessionId, 'fixture-session')
  const tools = [{ name: 'lookup', parameters: { type: 'object' } }]
  await host.complete({ ...input('qoder/model-a'), tools, toolChoice: 'none' }, () => {})
  assert.equal(dispatched.tools, undefined)
  for (const toolChoice of ['required', { type: 'function', function: { name: 'lookup' } }]) {
    const previous = dispatched
    await assert.rejects(host.complete({ ...input('qoder/model-a'), tools, toolChoice }, () => {}), error => error.code === 'CLIENT_ERROR' && error.status === 400)
    assert.equal(dispatched, previous, 'unsupported tool constraints must not reach the provider')
  }
  host.dispose()
  assert.equal(host.catalog().length, 0)
  console.log('ok host bridge dispatches the native provider exactly once without recursive OFM routing')

  const requests = []
  const fixture = setup(async (request, emit) => {
    requests.push(request)
    assert.equal(request.recordUsage, false)
    assert.equal(request.recordTurn, false)
    if (request.model === models[0].id) emit({ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'account quota' } } })
    else success(emit)
  })
  const combo = fixture.runtime.catalog.find(row => row.id === 'combo:accounts')
  assert.deepEqual(combo.combo, models.map(row => `account:${row.id}`))
  assert.equal(combo.contextWindow, 128000)
  const direct = await collect(fixture.runtime.adapter.stream(input()))
  assert.equal(direct.chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(requests.map(row => row.model), models.map(row => row.id))
  assert.equal(direct.chunks.filter(row => row.type === 'text-delta').length, 1)
  assert.equal(fixture.stats.get().requests, 2)
  assert.equal(fixture.stats.get().logical.turns, 1)
  assert.equal(fixture.stats.get().logical.models['combo:accounts'].turns, 1)
  console.log('ok combo fails over before output, with one physical sample per candidate and one logical turn')

  const before = fixture.stats.get().requests
  server = await startForwardServer({ config: () => ({ host: '127.0.0.1', port: 0, enabled: true, key: 'fixture-key' }), modelRows: fixture.runtime.publicModelRows, complete: fixture.runtime.complete })
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer fixture-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'combo:accounts', messages: [{ role: 'user', content: 'hello API' }] }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'account answer')
  assert.equal(fixture.stats.get().requests - before, 2)
  assert.equal(fixture.stats.get().logical.turns, 2)
  console.log('ok real OpenAI forward listener executes the same account-channel combo')

  let calls = 0
  const partial = setup(async (_request, emit) => {
    calls++
    emit({ type: 'text-delta', index: 0, text: 'visible' })
    emit({ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'late fault' } } })
  })
  const failed = await collect(partial.runtime.adapter.stream(input()))
  assert.equal(calls, 1)
  assert.equal(failed.chunks.at(-1).reason.failure.code, 'STREAM_CUT')
  assert.equal(partial.stats.get().logical.turns, 1)
  console.log('ok delivered output is never replayed or advanced to another provider')

  const abort = new AbortController()
  let cancelled = false
  const hanging = setup((request, _emit) => new Promise(resolve => {
    request.signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true })
    setImmediate(() => abort.abort())
  }))
  const cancelledResult = await collect(hanging.runtime.adapter.stream(input('combo:accounts', abort.signal)))
  assert.equal(cancelled, true)
  assert.equal(cancelledResult.chunks.at(-1).reason.kind, 'aborted')
  assert.equal(hanging.stats.get().requests, 1)
  assert.equal(hanging.stats.get().logical.turns, 1)
  console.log('ok cancellation propagates through callback bridge and does not fall through')

  let returnedAbort = false
  const early = setup(async (request, emit) => {
    emit({ type: 'text-delta', index: 0, text: 'visible' })
    await new Promise(resolve => request.signal.addEventListener('abort', () => { returnedAbort = true; resolve() }, { once: true }))
  })
  const iterator = early.runtime.adapter.stream(input())
  assert.equal((await iterator.next()).value.text, 'visible')
  await iterator.return()
  assert.equal(returnedAbort, true)
  assert.equal(early.stats.get().requests, 1)
  assert.equal(early.stats.get().logical.turns, 1)
  assert.equal(early.stats.get().logical.models['combo:accounts'].turns, 1)
  console.log('ok consumer return closes the child and records one physical request and logical turn')

  const budgets = []
  const budgeted = setup(async (request, emit) => { budgets.push(request.maxTokens); success(emit) })
  budgeted.settings.update({ defaultMaxTokens: 1234 })
  for (const maxTokens of [undefined, 2500, 999999]) {
    await budgeted.runtime.complete({ model: 'combo:accounts', messages: input().messages, maxTokens }, () => {})
  }
  assert.deepEqual(budgets, [1234, 2500, 32000])
  console.log('ok native account combos honor the global default, explicit request and provider output ceiling')

  fixture.setRows([models[1]])
  assert.deepEqual(fixture.runtime.catalog.find(row => row.id === 'combo:accounts').combo, [`account:${models[1].id}`])
  fixture.setRows([])
  assert.ok(!fixture.runtime.catalog.some(row => row.accountChannel || row.id === 'combo:accounts'))
  console.log('ok disabling/removing accounts rebuilds combo membership without stale routes')
} finally {
  await server?.close()
  for (const runtime of runtimes) runtime.dispose()
  for (const store of stores) store.dispose()
  fs.rmSync(scratch, { recursive: true, force: true })
}
