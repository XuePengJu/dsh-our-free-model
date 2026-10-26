/**
 * The degradation ring — what a chain tried before it answered.
 *
 * `recordTurn` only knows *how many* candidates were walked past. This ring is
 * the "why": one row per candidate, written from inside `runCombo` as it goes.
 * The properties that matter, each pinned below:
 *
 * - the walk order survives: a skipped candidate and the hit that followed it
 *   arrive newest-first, share one `chainId`, and carry a non-empty reason on
 *   the skipped row only;
 * - a non-advanceable failure (login wall) is an `aborted`, not a `skipped` —
 *   the difference between "another model could have answered" and "this turn
 *   was over";
 * - **a recorder that throws cannot change the answer.** That is the whole
 *   safety contract of putting a statistic in the request path;
 * - the ring is bounded at 200 and survives a stats file that predates it.
 *
 * Driven through the real Adapter against a local HTTP stand-in, same as
 * `combo-advance-test.mjs` — no new harness, no mocks of the adapter itself.
 *
 * Run: node scripts/combo-attempts-test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { chatFrames } from './lib/fake-kernel.mjs'

const TASK = 'COMBO_ATTEMPT_TASK_SENTINEL: answer the original question'
const ANSWER = 'VISIBLE_ANSWER_SENTINEL'
const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const answerBody = sse({ choices: [{ index: 0, delta: { content: ANSWER } }] })
  + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  + 'data: [DONE]\n\n'

let activeCase
const server = http.createServer((req, res) => {
  const pieces = []
  req.on('data', piece => pieces.push(piece))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(pieces).toString('utf8'))
    if (!JSON.stringify(body).includes(TASK)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatFrames('healthy local boot probe'))
      return
    }
    const scenario = activeCase
    const ordinal = scenario.requests.length
    scenario.requests.push({ body, path: req.url })
    const answer = scenario.answers[ordinal] ?? { status: 500, body: '{"error":{"message":"unexpected extra request"}}' }
    if (answer.status !== undefined) {
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(answer.body ?? '')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(answer.body ?? '')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
server.unref()
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`

const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')
const { buildCatalog } = await import('../src/catalog.js')
const { buildComboCatalog, normalizeCombos } = await import('../src/combos.js')
const { ATTEMPT_LIMIT, pruneAttempts, readAttempts, recordAttempt } = await import('../src/core/attempts.js')
const { createRuntimeStores } = await import('../src/core/runtime.js')

const MODELS = ['deepseek-v4-flash-free', 'mimo-v2.5-free', 'mimo-v2.6-flash-free']
const COMBO_ID = 'combo:failover'
const FREE_CATALOG = buildCatalog(MODELS)
const CATALOG = [...FREE_CATALOG, ...buildComboCatalog(
  normalizeCombos([{ name: 'failover', models: ['deepseek-v4-flash-free', 'mimo-v2.5-free'], strategy: 'fallback', stickyLimit: 1 }]),
  FREE_CATALOG,
)]

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`ok    ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

function setup(answers, recordAttemptOverride) {
  const scenario = { answers, requests: [] }
  activeCase = scenario
  const rows = []
  const turns = []
  const warnings = []
  const controller = new AbortController()
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog: CATALOG,
      membership: { [ROUTE_MAIN]: MODELS },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false },
      attributionUserAgent: 'offline-combo-attempts-test',
    }),
    recordUsage: () => {},
    recordTurn: row => turns.push(row),
    recordAttempt: recordAttemptOverride ?? (row => rows.push(row)),
    warn: message => warnings.push(message),
  })
  const stream = adapter.stream({
    provider: ROUTE_MAIN,
    model: COMBO_ID,
    maxTokens: 4096,
    sessionId: 'combo-attempts-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    signal: controller.signal,
  })
  return { scenario, rows, turns, warnings, controller, stream }
}

async function drive(answers, recordAttemptOverride) {
  const run = setup(answers, recordAttemptOverride)
  const chunks = []
  try {
    for await (const chunk of run.stream) chunks.push(chunk)
    return {
      ...run,
      chunks,
      finish: chunks.find(chunk => chunk.type === 'finish')?.reason,
      text: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
    }
  } finally {
    run.controller.abort()
  }
}

/** A stats store stand-in backed by a plain object (no disk, no timers). */
function memoryStore(initial = {}) {
  let value = initial
  return {
    get: () => value,
    edit(mutate) { value = mutate(structuredClone(value)); return value },
    peek: () => value,
  }
}

// —— 形状与边界：纯函数级 ——————————————————————————————————————————————

await check('an empty ring reads back as an empty array, never undefined', () => {
  assert.deepEqual(readAttempts(memoryStore({})), [], 'a stats file from before this feature has no field')
  assert.deepEqual(readAttempts(memoryStore({ attempts: null })), [], 'a null field is not an array')
  assert.deepEqual(readAttempts(memoryStore({ attempts: 'nope' })), [], 'a corrupted field is not an array')
  assert.deepEqual(readAttempts(memoryStore({ attempts: [] })), [])
})

await check('the ring is bounded and newest-first, and limit is clamped to [1, 200]', () => {
  const store = memoryStore({})
  for (let i = 0; i < ATTEMPT_LIMIT + 5; i += 1) {
    recordAttempt(store, {
      at: 1000 + i, chainId: COMBO_ID, chainName: 'failover', index: 0,
      candidateId: `model-${i}`, outcome: 'skipped', reason: 'rate limit', elapsedMs: i,
    })
  }
  assert.equal(store.peek().attempts.length, ATTEMPT_LIMIT, 'the ring never grows past the limit')
  assert.equal(store.peek().attempts[0].candidateId, `model-${ATTEMPT_LIMIT + 4}`, 'newest row is first')
  assert.equal(readAttempts(store, { limit: 0 }).length, 1, 'limit 0 clamps up to 1')
  assert.equal(readAttempts(store, { limit: 9999 }).length, ATTEMPT_LIMIT, 'limit 9999 clamps down to the ring size')
  assert.equal(readAttempts(store, { limit: 7 }).length, 7)
  assert.deepEqual(pruneAttempts(undefined, 10), [], 'prune tolerates a missing value')
  assert.equal(pruneAttempts(new Array(300).fill({}), 0).length, ATTEMPT_LIMIT, 'prune falls back to the module limit')
})

await check('a read returns copies, so a caller cannot mutate the ring', () => {
  const store = memoryStore({})
  recordAttempt(store, { chainId: COMBO_ID, chainName: 'failover', candidateId: 'a', outcome: 'hit' })
  const [row] = readAttempts(store)
  row.candidateId = 'tampered'
  assert.equal(store.peek().attempts[0].candidateId, 'a')
})

await check('a malformed row is normalized instead of thrown', () => {
  const store = memoryStore({})
  recordAttempt(store, { chainId: 42, index: -3, outcome: 'exploded', at: 'now', elapsedMs: -1 })
  const [row] = readAttempts(store)
  assert.equal(row.chainId, '', 'non-string chain id becomes empty')
  assert.equal(row.index, 0, 'a negative index floors at 0')
  assert.equal(row.outcome, 'skipped', 'an unknown outcome degrades to the common case')
  assert.equal(Number.isFinite(row.at), true, 'a non-finite timestamp is replaced by now')
  assert.equal(row.elapsedMs, 0)
})

await check('a store that throws is swallowed, warns once, and reports nothing up', () => {
  const warnings = []
  const broken = { edit() { throw new Error('disk full') }, get() { return {} } }
  assert.equal(recordAttempt(broken, { chainId: COMBO_ID, outcome: 'hit' }, message => warnings.push(message)), undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /disk full/)
  // A logger that itself throws must not escape either.
  assert.equal(recordAttempt(broken, {}, () => { throw new Error('logger exploded') }), undefined)
})

// —— 真实 store：落盘与旧文件兼容 ————————————————————————————————————————

await check('a store written without attempts keeps working and gains the field', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-attempts-'))
  try {
    // A stats.json from a build that predates this feature: no `attempts` key.
    fs.writeFileSync(path.join(dataDir, 'stats.json'), JSON.stringify({
      version: 4, days: {}, models: {}, requests: 3, failedRequests: 1, samples: [],
      logical: { turns: 3, failed: 1, recovered: 0, models: {} },
    }))
    const stores = createRuntimeStores({ dataDir, logger: { warn: () => {} } })
    assert.deepEqual(readAttempts(stores.stats), [], 'the endpoint reads [] rather than throwing')
    recordAttempt(stores.stats, {
      at: Date.now(), chainId: COMBO_ID, chainName: 'failover', index: 0,
      candidateId: MODELS[0], outcome: 'hit', reason: '', elapsedMs: 12,
    })
    assert.equal(readAttempts(stores.stats).length, 1)
    stores.stats.flush()
    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats.json'), 'utf8'))
    assert.equal(Array.isArray(written.attempts), true, 'the field is persisted')
    assert.equal(written.attempts[0].candidateId, MODELS[0])
    assert.equal(written.requests, 3, 'the rest of the file is untouched')
    stores.stats.dispose()
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }) }
})

// —— 适配器：真的跑一遍链 ——————————————————————————————————————————————

await check('a 429 candidate is recorded as skipped, the answering candidate as hit', async () => {
  // Drive the real ring, not a spy array: the store is what the endpoint reads.
  const store = memoryStore({})
  const run = await drive([
    { status: 429, body: '{"error":{"message":"rate limit exceeded"}}' },
    { body: answerBody },
  ], row => recordAttempt(store, row))
  assert.equal(run.scenario.requests.length, 2, 'the chain really advanced')
  assert.equal(run.text, ANSWER)
  assert.equal(run.rows.length, 0, 'the spy array stays empty when the override writes to the ring')
  const ring = readAttempts(store)
  assert.equal(ring.length, 2, 'one row per candidate tried')
  assert.deepEqual(ring.map(row => row.outcome), ['hit', 'skipped'], 'rows arrive newest-first')
  assert.equal(ring[0].index, 1, 'the hit is candidate 1 (zero-based)')
  assert.equal(ring[1].index, 0)
  assert.equal(ring[0].candidateId, MODELS[1])
  assert.equal(ring[1].candidateId, MODELS[0])
  assert.equal(ring[0].reason, '', 'a hit carries no reason')
  assert.match(ring[1].reason, /rate limit/i, 'the skip carries the verdict text')
  assert.equal(new Set(ring.map(row => row.chainId)).size, 1, 'both rows describe one chain')
  assert.equal(ring[0].chainId, COMBO_ID)
  assert.equal(ring[0].chainName, 'failover')
  for (const row of ring) {
    assert.equal(Number.isFinite(row.at), true)
    assert.equal(row.elapsedMs >= 0, true, `elapsedMs must be a duration, got ${row.elapsedMs}`)
    assert.equal(row.tps, undefined, 'speed is never invented here')
    assert.equal(row.ttftMs, undefined, 'speed is never invented here')
  }
  assert.equal(run.turns[0].attempts, 2, 'the turn record still counts the same attempts')
})

await check('a login wall ends the turn and is recorded as aborted, not skipped', async () => {
  const run = await drive([
    { status: 403, body: JSON.stringify({ error: { type: 'AuthorizationRequired', message: 'login required' } }) },
    { body: answerBody },
  ])
  assert.equal(run.scenario.requests.length, 1, 'a non-advanceable failure stops the chain')
  assert.equal(run.finish?.kind, 'error')
  assert.equal(run.rows.length, 1)
  assert.equal(run.rows[0].outcome, 'aborted')
  assert.equal(run.rows[0].reason, 'aborted')
  assert.equal(run.rows[0].index, 0)
})

await check('a committed candidate that then fails is recorded as a hit', async () => {
  const run = await drive([
    { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ error: { message: 'rate limit exceeded' } }) },
  ])
  assert.equal(run.finish?.kind, 'error')
  assert.equal(run.rows.length, 1)
  assert.equal(run.rows[0].outcome, 'hit', 'the answer reached the caller, so the candidate did its job')
})

await check('a recorder that throws cannot change the answer', async () => {
  const run = await drive([
    { status: 429, body: '{"error":{"message":"rate limit exceeded"}}' },
    { body: answerBody },
  ], () => { throw new Error('recorder exploded') })
  assert.equal(run.scenario.requests.length, 2, 'the chain still walked both candidates')
  assert.equal(run.text, ANSWER, 'the caller still gets the answer')
  assert.equal(run.finish?.kind, 'stop', 'the turn finishes normally')
  assert.equal(run.turns.length, 1)
  assert.equal(run.turns[0].ok, true)
})

// A caller who pulls the plug mid-stream makes `runSingle` report its usual
// advanceable transient fault, so the chain walks on rather than stopping —
// that is existing routing behaviour and not this feature's business. What
// this pins is narrower and still worth pinning: recording happens on the
// unwinding path too, one row per candidate, and none of it throws back into
// the generator the caller is tearing down.
await check('an abandoned stream still records every candidate it walked', async () => {
  const run = setup([
    // Never answers and never fails on its own: the caller pulls the plug.
    { body: sse({ choices: [{ index: 0, delta: { reasoning: 'thinking' } }] }) },
  ])
  const iterator = run.stream[Symbol.asyncIterator]()
  await iterator.next()
  run.controller.abort()
  for (;;) {
    const row = await iterator.next()
    if (row.done === true) break
  }
  assert.ok(run.rows.length >= 1, 'the abandoned turn is still recorded')
  assert.equal(run.rows[0].candidateId, MODELS[0], 'the first row names the candidate we pulled the plug on')
  assert.equal(run.rows.every(row => row.chainId === COMBO_ID), true)
  assert.equal(run.rows.every(row => ['hit', 'skipped', 'aborted'].includes(row.outcome)), true)
})

// —— 批次 5b：回合身份 turnAt、周期跳过数 skippedCandidates、前端分组 ————————

await check('rows of one turn share turnAt while their own at differs', async () => {
  const store = memoryStore({})
  const run = await drive([
    { status: 429, body: '{"error":{"message":"rate limit exceeded"}}' },
    { body: answerBody },
  ], row => recordAttempt(store, row))
  const ring = readAttempts(store)
  assert.equal(ring.length, 2)
  assert.equal(ring[0].turnAt, ring[1].turnAt, 'both rows describe the same walk')
  assert.notEqual(ring[0].at, ring[1].at, 'each row still carries its own write time')
  assert.equal(ring[0].elapsedMs >= ring[1].elapsedMs, true, 'elapsedMs is measured from the turn start')
})

await check('recordTurn accumulates skipped candidates in the day bucket and logical', async () => {
  const { recordTurn } = await import('../src/store.js')
  const store = memoryStore({})
  recordTurn(store, { at: Date.now(), model: 'm', ok: true, recovered: false, attempts: 3 })
  recordTurn(store, { at: Date.now(), model: 'm', ok: true, recovered: false, attempts: 1 })
  recordTurn(store, { at: Date.now(), model: 'm', ok: true, recovered: false, attempts: 0 })
  recordTurn(store, { at: Date.now(), model: 'm', ok: false, recovered: false })
  const state = store.peek()
  const bucket = Object.values(state.days)[0]
  assert.equal(bucket.skippedCandidates, 2, 'attempts 3 → 2 skips; 1 and 0 and missing → 0')
  assert.equal(state.logical.skippedCandidates, 2)
})

await check('aggregatePeriod reports skippedCandidates for day and all alike', async () => {
  const { aggregatePeriod } = await import('../src/core/usage-periods.js')
  const day = '2026-10-26'
  const now = new Date('2026-10-26T12:00:00+08:00').getTime()
  const stats = {
    version: 4,
    requests: 10,
    failedRequests: 1,
    models: {},
    samples: [],
    logical: { turns: 2, failed: 0, recovered: 0, models: {} },
    days: { [day]: { turns: 2, failedTurns: 0, recoveredTurns: 0, skippedCandidates: 5, models: {}, modelsTurns: {} } },
  }
  const dayView = aggregatePeriod(stats, 'day', [], now)
  assert.equal(dayView.metrics.skippedCandidates, 5, 'the day bucket total is passed through')
  const allView = aggregatePeriod(stats, 'all', [], now)
  assert.equal(allView.metrics.skippedCandidates, 5, 'all reads the same buckets')
  const empty = aggregatePeriod({ ...stats, days: {} }, 'day', [], now)
  assert.equal(empty.metrics.skippedCandidates, 0, 'empty buckets read 0 — the same treatment recoveredTurns gets')
})

await check('latestChainTurn groups by turnAt and never guesses from proximity', async () => {
  const { latestChainTurn } = await import('../packages/standalone/frontend/usage-data.mjs')
  const row = over => ({ turnAt: 1000, at: 1000 + over, chainId: 'combo:a', chainName: 'a', index: over, candidateId: `m${over}`, outcome: 'hit', reason: '', elapsedMs: over })
  assert.equal(latestChainTurn(undefined, { chainId: 'combo:a' }), null, 'not an array → null')
  assert.equal(latestChainTurn([row(0)], { chainId: '' }), null, 'no active chain → null')
  assert.equal(latestChainTurn([row(0)], { chainId: 'combo:b' }), null, 'another chain → null')
  const newer = { ...row(0), turnAt: 5000, at: 5001, chainId: 'combo:b' }
  const turn = latestChainTurn([newer, row(1), row(0)], { chainId: 'combo:a' })
  assert.equal(turn.turnAt, 1000, 'the newest turn of the requested chain wins')
  assert.deepEqual(turn.rows.map(item => item.index), [0, 1], 'rows come back in walk order')
  const legacy = { at: 9000, chainId: 'combo:a', index: 0, outcome: 'skipped', reason: 'x', elapsedMs: 0 }
  const legacyTurn = latestChainTurn([legacy], { chainId: 'combo:a' })
  assert.equal(legacyTurn.turnAt, 9000, 'a row without turnAt falls back to its own at (one row per group)')
})

server.close()
console.log(failures > 0
  ? `combo-attempts-test: ${failures} failure(s)`
  : 'combo-attempts-test: the ring records the walk, stays bounded, and never fails a request')
process.exitCode = failures > 0 ? 1 : 0
