/** EAC model metadata survives a listing refresh and a real cache restart (#825). */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeStores, createModelRuntime } from '../src/core/runtime.js'
import { lane } from '../src/eac.js'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-eac-metadata-'))
const logger = { warn() {}, info() {} }
const row = { id: 'openai/runtime-fixture', context_length: 400000, max_output: 64000, modalities: { input: ['text', 'image'] } }
const credential = () => ({ mode: 'worker', base: 'https://fixture.invalid/eac/v1', signingSecret: 'ab'.repeat(32) })
const saved = lane.fetch
let stores, runtime
try {
  lane.fetch = async () => new Response(JSON.stringify({ data: [row] }), { headers: { 'content-type': 'application/json' } })
  stores = createRuntimeStores({ dataDir: directory, logger })
  runtime = createModelRuntime({ ...stores, logger, sealedCredential: credential })
  await runtime.refreshSealedLane()
  const first = runtime.catalog.find(model => model.id === row.id)
  assert.equal(first.contextWindow, 400000)
  assert.equal(first.maxOutput, 64000)
  assert.equal(first.vision, true)
  assert.deepEqual(stores.catalogStore.get().sealIds, [row])
  runtime.dispose(); stores.dispose()
  stores = createRuntimeStores({ dataDir: directory, logger })
  runtime = createModelRuntime({ ...stores, logger, sealedCredential: credential })
  const restored = runtime.catalog.find(model => model.id === row.id)
  assert.equal(restored.contextWindow, first.contextWindow)
  assert.equal(restored.maxOutput, first.maxOutput)
  assert.equal(restored.vision, true)
  runtime.dispose()
  stores.catalogStore.update({ sealIds: ['openai/legacy-fixture', '[object Object]', {}] })
  runtime = createModelRuntime({ ...stores, logger, sealedCredential: credential })
  assert.ok(runtime.catalog.some(model => model.id === 'openai/legacy-fixture'))
  assert.ok(!runtime.catalog.some(model => model.id.includes('[object ')))
  console.log('ok EAC row context/output/image metadata persists across refresh/restart; legacy ID cache remains supported')
} finally {
  runtime?.dispose(); stores?.dispose(); lane.fetch = saved
  fs.rmSync(directory, { recursive: true, force: true })
}
