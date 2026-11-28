import assert from 'node:assert/strict'
import { buildCatalog, buildEacCatalog, capabilitiesFor, parseListing, upstreamCapabilities } from '../src/catalog.js'

let checks = 0
function test(name, fn) {
  fn()
  checks += 1
  console.log(`ok ${name}`)
}

test('free serving limits reach the host catalog and cannot be inflated by the listing (#744)', () => {
  for (const id of ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free']) {
    const [plain] = buildCatalog([id])
    const [listed] = buildCatalog([{ id, context_length: 1048576, max_output: 393216 }])
    for (const row of [plain, listed]) {
      assert.equal(row.contextWindow, 200000)
      assert.equal(row.maxOutput, 32000)
      assert.ok(row.efforts.includes('high'))
    }
    const narrower = capabilitiesFor(id, { context_length: 180000, max_output: 16000 })
    assert.equal(narrower.contextWindow, 180000)
    assert.equal(narrower.maxOutput, 16000)
  }
})

test('other lanes retain their independently declared windows', () => {
  assert.equal(buildCatalog(['mimo-v2.6-flash-free'])[0].contextWindow, 1048576)
  assert.equal(buildEacCatalog(['deepseek-ai/deepseek-v4.1-flash'])[0].contextWindow, 1048576)
  assert.equal(buildEacCatalog(['opencode/deepseek-v4.1-flash-free'])[0].contextWindow, 409600)
})

test('EAC keeps complete metadata without mutating the listing or its local fallback (#825)', () => {
  const original = {
    id: 'opencode/mimo-v2.6-flash-free', context_length: 786432, max_output: 65536,
    modalities: { input: ['text', 'image'] }, reasoning: false,
  }
  const saved = structuredClone(original)
  const [entry] = buildEacCatalog(parseListing({ data: [original] }))
  assert.equal(entry.id, original.id)
  assert.equal(entry.contextWindow, 786432)
  assert.equal(entry.maxOutput, 65536)
  assert.equal(entry.vision, true)
  assert.equal(entry.reasoning, false)
  assert.deepEqual(original, saved)
  const [fallback] = buildEacCatalog([original.id])
  assert.equal(fallback.contextWindow, 1048576)
  assert.equal(fallback.maxOutput, 131072)
})

test('EAC old id-only cache uses a known family, and unknown ids stay conservative', () => {
  const entries = buildEacCatalog(['opencode/mimo-v2.6-flash-free', 'unknown/new-model', 'unknown/new-model'])
  assert.equal(entries.length, 2)
  assert.equal(entries[0].vision, true)
  assert.equal(entries[0].contextWindow, 1048576)
  assert.equal(entries[1].contextWindow, 131072)
  assert.equal(entries[1].maxOutput, 32768)
  assert.equal(entries[1].vision, false)
  assert.equal(entries[1].efforts, undefined)
})

test('modality-only and reasoning-only metadata are not discarded', () => {
  assert.deepEqual(upstreamCapabilities({ modalities: { input: ['image'] } }), { vision: true })
  assert.deepEqual(upstreamCapabilities({ reasoning: false }), { reasoning: false })
  assert.equal(buildEacCatalog([{ id: 'unknown/image-model', modalities: { input: ['image'] } }])[0].vision, true)
  assert.equal(upstreamCapabilities({ context_length: -1, max_output: Infinity }), null)
  assert.equal(upstreamCapabilities('old-id'), null)
})

test('wire fields override known EAC capacities and curated effort menus stay intact', () => {
  const [entry] = buildEacCatalog([{
    id: 'deepseek-ai/deepseek-v4.1-flash', context_window: 262144, max_output: 8192,
    reasoning_efforts: ['none', 'high'], metadata: { input_modalities: ['text'] },
  }])
  assert.equal(entry.contextWindow, 262144)
  assert.equal(entry.maxOutput, 8192)
  assert.equal(entry.vision, false)
  assert.deepEqual(entry.efforts, ['disabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  entry.efforts.splice(0)
  assert.ok(buildEacCatalog(['deepseek-ai/deepseek-v4.1-flash'])[0].efforts.includes('high'))
})

test('MiniMax uses the relay-specific 256K window, not a vendor 1M fallback (#758)', () => {
  for (const raw of [
    'minimaxai/minimax-m3.1-flash',
    { id: 'minimaxai/minimax-m3.1-flash', context_length: 1048576, max_output: 131072 },
  ]) {
    const [entry] = buildEacCatalog([raw])
    assert.equal(entry.name, 'EAC MiniMax M3.1 Flash')
    assert.equal(entry.contextWindow, 262144)
    assert.equal(entry.maxOutput, 32768)
  }
})

console.log(`catalog-metadata-test: ${checks}/${checks} passed`)
