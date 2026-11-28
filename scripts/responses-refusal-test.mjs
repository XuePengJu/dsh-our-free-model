/**
 * Proves a model refusal reaches the user instead of ending the turn empty.
 *
 * A refusal arrives as response.refusal.delta on the Responses wire and as
 * delta.refusal on the Chat wire. Both used to fall through the reader, so a
 * refusal-only turn closed with zero blocks and finish 'stop' — exactly the
 * input src/adapter.js turns into EMPTY_RESPONSE, which is a retryable code:
 * one real answer was billed up to three times and never shown. These cases pin
 * the refusal text onto the same text-block path the visible answer uses.
 *
 * The decoder cases are pure memory. The terminal/error regression cases use a
 * real FreeModelAdapter against a loopback HTTP fixture bound to 127.0.0.1:0.
 *
 * Run: node scripts/responses-refusal-test.mjs
 */
import http from 'node:http'
import process from 'node:process'

const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const outputDelta = text => sse({ type: 'response.output_text.delta', output_index: 0, delta: text })
const incomplete = reason => sse({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason } } })
const complete = text => outputDelta(text) + sse({ type: 'response.completed', response: { status: 'completed' } })

let activeScenario
const fixtureServer = http.createServer((req, res) => {
  const pieces = []
  req.on('data', piece => pieces.push(piece))
  req.on('end', () => {
    if (!activeScenario) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('no active content-filter fixture')
      return
    }
    let body = {}
    try { body = JSON.parse(Buffer.concat(pieces).toString('utf8') || '{}') } catch { /* keep the captured malformed body */ }
    const ordinal = activeScenario.requests.length
    activeScenario.requests.push({ path: req.url, body })
    const answer = activeScenario.responses[ordinal] ?? complete('UNEXPECTED_EXTRA_REQUEST')
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.end(answer)
  })
})
await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve))
fixtureServer.unref()
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${fixtureServer.address().port}`

// Import only after pinning the base URL: upstream.js reads it at module load.
const { readStream } = await import('../src/stream.js')

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name
    + (ok ? '' : ' — got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)))
}

/** Read a whole frame list, keeping the generator's final state. */
const drain = async (frames, wire) => {
  const chunks = []
  const iterator = readStream(frames, wire, new Map())
  for (;;) {
    const step = await iterator.next()
    if (step.done) return { chunks, state: step.value }
    chunks.push(step.value)
  }
}

const starts = chunks => chunks.filter(chunk => chunk.type === 'block-start')
  .map(chunk => String(chunk.index) + ':' + chunk.blockType)
const ends = chunks => chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.index)
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const closedText = chunks => chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'text')
  .map(chunk => chunk.block.text)

const REFUSAL = 'I cannot help with that.'

const responsesRefusal = () => [
  JSON.stringify({ type: 'response.content_part.added', output_index: 0, part: { type: 'refusal', refusal: '' } }),
  JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: REFUSAL }),
  JSON.stringify({ type: 'response.refusal.done', output_index: 0, refusal: REFUSAL }),
  JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 7 } } }),
]

const chatRefusal = () => [
  JSON.stringify({ choices: [{ index: 0, delta: { refusal: REFUSAL } }] }),
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]',
]

// REF-1: a Responses turn that is nothing but a refusal is still a turn.
{
  const { chunks, state } = await drain(responsesRefusal(), 'responses')
  check('REF-1 responses refusal opens one text block', starts(chunks), ['0:text'])
  check('REF-1 the refusal is the visible text', textOf(chunks), REFUSAL)
  check('REF-1 the block closes once carrying the refusal', closedText(chunks), [REFUSAL])
  check('REF-1 the turn no longer reads as empty', state.sawText, true)
  check('REF-1 the finish reason is untouched', state.finish, 'stop')
}

// REF-2: the same refusal on the Chat wire, under delta.refusal.
{
  const { chunks, state } = await drain(chatRefusal(), 'chat')
  check('REF-2 chat refusal opens one text block', starts(chunks), ['0:text'])
  check('REF-2 the refusal is the visible text', textOf(chunks), REFUSAL)
  check('REF-2 the block closes once carrying the refusal', closedText(chunks), [REFUSAL])
  check('REF-2 the turn no longer reads as empty', state.sawText, true)
  check('REF-2 the finish reason is untouched', state.finish, 'stop')
}

// REF-3: delta plus the echo frame must not print the refusal twice.
{
  const frames = [
    JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: REFUSAL }),
    JSON.stringify({ type: 'response.refusal.done', output_index: 0, refusal: REFUSAL }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
  ]
  const { chunks } = await drain(frames, 'responses')
  check('REF-3 the echo frame does not double the refusal', textOf(chunks), REFUSAL)
  check('REF-3 there is still exactly one text block', starts(chunks), ['0:text'])
  check('REF-3 and it closes exactly once', ends(chunks), [0])
}

// REF-4: the ordinary answer paths keep behaving exactly as before.
{
  const frames = [
    JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello' }),
    JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: ' world' }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
  ]
  const { chunks, state } = await drain(frames, 'responses')
  check('REF-4 output_text still builds one text block', starts(chunks), ['0:text'])
  check('REF-4 output_text still concatenates', textOf(chunks), 'Hello world')
  check('REF-4 output_text still closes once', ends(chunks), [0])
  check('REF-4 output_text still reports text and stop', [state.sawText, state.finish], [true, 'stop'])
}
{
  const frames = [
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { content: ' world' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]',
  ]
  const { chunks, state } = await drain(frames, 'chat')
  check('REF-4 chat content still builds one text block', starts(chunks), ['0:text'])
  check('REF-4 chat content still concatenates', textOf(chunks), 'Hello world')
  check('REF-4 chat content still closes once', ends(chunks), [0])
  check('REF-4 chat content still reports text and stop', [state.sawText, state.finish], [true, 'stop'])
}

// REF-5: reasoning that ends in a refusal keeps block indices contiguous and
// closes every block exactly once.
{
  const frames = [
    JSON.stringify({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'weighing it' }),
    JSON.stringify({ type: 'response.refusal.delta', output_index: 1, delta: REFUSAL }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
  ]
  const { chunks, state } = await drain(frames, 'responses')
  check('REF-5 reasoning then refusal keeps contiguous indices', starts(chunks), ['0:reasoning', '1:text'])
  check('REF-5 each block ends exactly once', ends(chunks), [0, 1])
  check('REF-5 the refusal owns the second block', closedText(chunks), [REFUSAL])
  check('REF-5 both kinds are reported', [state.sawReasoning, state.sawText], [true, true])
}

// REF-6: a refusal followed by a tool call keeps the two blocks apart.
{
  const frames = [
    JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: REFUSAL }),
    JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read_file' } }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a.txt"}' }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
  ]
  const { chunks, state } = await drain(frames, 'responses')
  check('REF-6 the refusal and the call are separate blocks', starts(chunks), ['0:text', '1:tool-call'])
  check('REF-6 neither block swallows the other', ends(chunks), [0, 1])
  check('REF-6 the refusal text stays in its own block', closedText(chunks), [REFUSAL])
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  check('REF-6 the call still closes with its arguments', [call?.block?.name, call?.block?.arguments], ['read_file', '{"path":"a.txt"}'])
  check('REF-6 both a refusal and a tool call are reported', [state.sawText, state.sawToolCall], [true, true])
}

// REF-7: a gateway that sends an empty or null refusal must not open a block.
{
  const frames = [
    JSON.stringify({ type: 'response.content_part.added', output_index: 0, part: { type: 'refusal', refusal: '' } }),
    JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: '' }),
    JSON.stringify({ type: 'response.refusal.delta', output_index: 0, delta: null }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
  ]
  const { chunks, state } = await drain(frames, 'responses')
  check('REF-7 an empty responses refusal emits nothing', chunks, [])
  check('REF-7 and does not claim text arrived', state.sawText, false)
}
{
  const frames = [
    JSON.stringify({ choices: [{ index: 0, delta: { refusal: '' } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { refusal: null } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ]
  const { chunks, state } = await drain(frames, 'chat')
  check('REF-7 an empty chat refusal emits nothing', chunks, [])
  check('REF-7 and does not claim text arrived', state.sawText, false)
}

// Content filtering is a terminal request failure. These cases intentionally
// cross the real adapter boundary: a parser-only assertion cannot prove that a
// partial block closes, recovery stays off, or a combo does not rotate.
const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')
const { buildCatalog } = await import('../src/catalog.js')
const { buildComboCatalog, normalizeCombos } = await import('../src/combos.js')
const MODEL_IDS = ['muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free']
const MODEL_CATALOG = buildCatalog(MODEL_IDS)
const COMBO_ID = 'combo:responses-content-filter'
const COMBO_CATALOG = buildComboCatalog(normalizeCombos([
  { id: COMBO_ID, name: 'Responses content filter', models: MODEL_IDS, strategy: 'fallback' },
]), MODEL_CATALOG)
const CATALOG = [...MODEL_CATALOG, ...COMBO_CATALOG]

async function adapterTurn(model, responses) {
  const scenario = { responses, requests: [] }
  activeScenario = scenario
  const records = []
  const controller = new AbortController()
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog: CATALOG,
      membership: { [ROUTE_MAIN]: MODEL_IDS },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: true },
      attributionUserAgent: 'offline-responses-content-filter-test',
    }),
    recordUsage: row => records.push(row),
    recordTurn: () => {},
    warn: () => {},
  })
  const chunks = []
  try {
    for await (const chunk of adapter.stream({
      provider: ROUTE_MAIN,
      model,
      maxTokens: 4096,
      sessionId: 'responses-content-filter-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'CONTENT_FILTER_FIXTURE_SENTINEL' }] }],
      signal: controller.signal,
    })) chunks.push(chunk)
  } finally {
    controller.abort()
    activeScenario = undefined
  }
  return {
    chunks,
    records,
    requests: scenario.requests,
    finish: chunks.find(chunk => chunk.type === 'finish')?.reason,
  }
}

const FILTERED_TEXT = 'PARTIAL_TEXT_BEFORE_CONTENT_FILTER'
{
  const run = await adapterTurn(MODEL_IDS[0], [
    outputDelta(FILTERED_TEXT) + incomplete('content_filter'),
    complete('MUST_NOT_BE_CONTINUED'),
  ])
  check('CF-1 partial content_filter sends exactly one request', run.requests.length, 1)
  check('CF-1 partial answer remains visible once', textOf(run.chunks), FILTERED_TEXT)
  check('CF-1 partial text block closes with the emitted text', closedText(run.chunks), [FILTERED_TEXT])
  check('CF-1 filter is surfaced as an error finish', run.finish?.kind, 'error')
  check('CF-1 filter exposes CONTENT_BLOCKED', run.finish?.failure?.code, 'CONTENT_BLOCKED')
}

{
  const run = await adapterTurn(COMBO_ID, [
    incomplete('content_filter'),
    complete('MUST_NOT_FALL_BACK'),
  ])
  check('CF-2 zero-text content_filter sends exactly one combo request', run.requests.length, 1)
  check('CF-2 the combo starts with the first Responses model', run.requests[0]?.body?.model, MODEL_IDS[0])
  check('CF-2 zero-text filter is surfaced as an error finish', run.finish?.kind, 'error')
  check('CF-2 zero-text filter exposes CONTENT_BLOCKED', run.finish?.failure?.code, 'CONTENT_BLOCKED')
  check('CF-2 zero-text filter is not EMPTY_RESPONSE', run.finish?.failure?.code === 'EMPTY_RESPONSE', false)
}

{
  const prefix = 'MAX_OUTPUT_TOKENS_PREFIX'
  const suffix = 'MAX_OUTPUT_TOKENS_SUFFIX'
  const run = await adapterTurn(MODEL_IDS[0], [
    outputDelta(prefix) + incomplete('max_output_tokens'),
    complete(suffix),
  ])
  check('CF-3 max_output_tokens still performs one continuation request', run.requests.length, 2)
  check('CF-3 both answer parts survive the continuation', textOf(run.chunks), prefix + suffix)
  check('CF-3 the continuation ends normally', run.finish?.kind, 'stop')
  check('CF-3 the first attempt records continuation scheduling', run.records[0]?.recoveryScheduled, true)
}

await new Promise(resolve => fixtureServer.close(resolve))

console.log(failures === 0
  ? '\nresponses-refusal: refusal decoding and content-filter adapter termination'
  : '\n' + failures + ' check(s) failed')
process.exitCode = failures === 0 ? 0 : 1
