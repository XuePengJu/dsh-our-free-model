/** Offline regressions run inside channel-pack-test.mjs --source. */
import assert from 'node:assert/strict'

const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const text = (role, value) => ({ role, content: [{ type: 'text', text: value }] })
const identity = 'You are an AI agent powered by DeepSeek Harness.'
const oldIdentity = 'You are an AI agent, powered by DeepSeek Harness.'
const neutral = 'You are an AI assistant.'
const answer = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function verifyChannelCompatibility({ adapters, outletState }) {
  const { QoderAdapter } = await import('../vendor/channel-pack/src/qoder-adapter.ts')
  const { QoderEncryptedInfer, buildQoderInferPayload } = await import('../vendor/channel-pack/src/qoder-wasm.ts')
  const { QODER_CN } = await import('../vendor/channel-pack/src/qoder-product.ts')
  const { GeminiAdapter } = await import('../vendor/channel-pack/src/gemini-adapter.ts')
  const { compatibleHarnessPromptMessage } = await import('../vendor/channel-pack/src/harness-identity.ts')
  const create = QoderEncryptedInfer.create
  const headersTimeout = process.env.DSH_QODER_HEADERS_TIMEOUT_MS
  const previousOutlet = { active: outletState.active, respond: outletState.respond }
  const options = { provider: 'qoder', model: 'qfmodel', messages: [text('user', 'hello')] }
  const credential = { access_token: 'fixture', machine_id: 'fixture', uid: 'fixture' }
  try {
    // Inspect the actual options captured by the mounted registrations. Merely
    // testing createChannelFetch cannot detect an adapter that never received it.
    outletState.active = true
    const seen = []
    outletState.respond = async (input, init) => {
      seen.push([String(input), init.body])
      return new Response('proxied')
    }
    for (const provider of ['qoder', 'qodercn', 'trae']) {
      assert.equal(await (await adapters.get(provider).fetchImpl('https://fixture.invalid/infer', {
        method: 'POST', body: provider,
      })).text(), 'proxied')
    }
    assert.deepEqual(seen.map(row => row[1]), ['qoder', 'qodercn', 'trae'])
    outletState.active = previousOutlet.active
    outletState.respond = previousOutlet.respond
    console.log('ok  #910: mounted Qoder/QoderCN/TRAE use the configured outlet')

    // Mock only encryption, retaining the actual adapter -> payload builder ->
    // fetch boundary. No real user, machine token, credentials or network.
    QoderEncryptedInfer.create = async () => ({
      prepareInfer(ask) {
        return { url: 'https://fixture.invalid/infer', headers: {}, body: JSON.stringify(buildQoderInferPayload(ask, 'fixture')) }
      },
      dispose() {},
    })
    for (const product of [undefined, QODER_CN]) {
      let sent
      const adapter = new QoderAdapter({ credentialRef: 'FIXTURE', product,
        resolveCredential: async () => credential, refresh: async () => { throw new Error('unexpected refresh') },
        fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return answer() },
      })
      const messages = [text('system', `before ${oldIdentity} after`), text('developer', identity),
        text('user', identity), text('assistant', oldIdentity)]
      const before = structuredClone(messages)
      await collect(adapter.stream({ ...options, messages, system: `prefix\n${identity}\nsuffix` }))
      assert.equal(sent.system[0].text, `prefix\n${neutral}\nsuffix`)
      assert.equal(sent.messages.find(row => row.role === 'system').content, `before ${neutral} after`)
      assert.equal(sent.messages.find(row => row.role === 'user').content, identity)
      assert.equal(sent.messages.find(row => row.role === 'assistant').content, oldIdentity)
      assert.equal(sent.messages.some(row => row.role === 'developer'), false, 'existing metadata omission is retained')
      assert.deepEqual(messages, before)
    }
    let geminiSent
    const gemini = new GeminiAdapter({ credentialRef: 'FIXTURE', project: 'fixture-project',
      resolveCredential: async () => ({ access_token: 'fixture', refresh_token: 'fixture', project_id: 'fixture-project' }),
      refresh: async () => {},
      fetchImpl: async (_url, init) => {
        geminiSent = JSON.parse(init.body)
        return new Response('data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n')
      },
    })
    const geminiMessages = [text('system', `before ${oldIdentity} after`), text('developer', identity), text('user', identity)]
    const geminiBefore = structuredClone(geminiMessages)
    await collect(gemini.stream({ provider: 'gemini', model: gemini.listAllModels()[0].id,
      messages: geminiMessages, system: `prefix\n${identity}\nsuffix` }))
    assert.equal(geminiSent.request.systemInstruction.parts[0].text, `prefix\n${neutral}\nsuffix\n\nbefore ${neutral} after`)
    assert.equal(geminiSent.request.contents[0].parts[0].text, identity)
    assert.deepEqual(geminiMessages, geminiBefore)
    for (const role of ['system', 'developer']) {
      assert.equal(compatibleHarnessPromptMessage(text(role, identity)).content[0].text, neutral)
    }
    for (const role of ['user', 'assistant', 'tool']) {
      const row = text(role, identity)
      assert.equal(compatibleHarnessPromptMessage(row), row)
    }
    const unrelated = text('system', 'You are an AI agent powered by DeepSeek Harness')
    assert.equal(compatibleHarnessPromptMessage(unrelated), unrelated, 'only the two complete default sentences change')
    console.log('ok  #931/#902: real Qoder/QoderCN/Gemini outbound payloads normalize only default system identities')

    // #951's direct WASM probe used a different tools shape from the adapter.
    // Exercise the real boundary, including its SSE envelope, before deciding
    // that a provider response is a local transport failure or retry loop.
    const tool = { name: 'fixture_read', description: 'Read a fixture', parameters: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
    } }
    const envelope = body => `data: ${JSON.stringify({ body: JSON.stringify(body) })}\n\n`
    let toolPayload, toolRequests = 0
    const withTools = new QoderAdapter({ credentialRef: 'FIXTURE', resolveCredential: async () => credential,
      refresh: async () => { throw new Error('tools must not refresh credentials') },
      fetchImpl: async (_url, init) => {
        toolRequests++
        toolPayload = JSON.parse(init.body)
        return new Response(envelope({ choices: [{ delta: { tool_calls: [{ index: 0,
          id: 'fixture-call', type: 'function', function: { name: tool.name, arguments: '{"path":"a"}' },
        }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n')
      },
    })
    const toolChunks = await collect(withTools.stream({ ...options, tools: [tool] }))
    assert.deepEqual(toolPayload.tools, [{ type: 'function', function: tool }])
    assert.equal(toolChunks.at(-1).reason.kind, 'tool-calls')
    assert.equal(toolRequests, 1)
    for (const business of [
      { code: 'provider_error', message: 'fixture provider rejected tools', type: 'model_error' },
      { error: { code: 'provider_error', message: 'fixture nested provider error' } },
    ]) {
      let requests = 0, refreshes = 0
      const failing = new QoderAdapter({ credentialRef: 'FIXTURE', resolveCredential: async () => credential,
        refresh: async () => { refreshes++ },
        fetchImpl: async () => { requests++; return new Response(envelope(business)) },
      })
      await assert.rejects(collect(failing.stream({ ...options, tools: [tool] })), error =>
        error.code === 'SERVER' && /provider/.test(error.message) && !/transport error/.test(error.message))
      assert.equal(requests, 1, 'a business error does not enter the adapter queue or refresh loop')
      assert.equal(refreshes, 0)
    }
    const disconnected = new QoderAdapter({ credentialRef: 'FIXTURE', resolveCredential: async () => credential,
      refresh: async () => {}, fetchImpl: async () => { throw new TypeError('fetch failed') },
    })
    await assert.rejects(collect(disconnected.stream(options)), error => error.code === 'TRANSPORT')
    console.log('ok  #951: actual tool envelope works; provider errors stay distinct from transport and do not loop internally')

    process.env.DSH_QODER_HEADERS_TIMEOUT_MS = '20'
    const make = fetchImpl => new QoderAdapter({ credentialRef: 'FIXTURE', resolveCredential: async () => credential,
      refresh: async () => {}, fetchImpl })
    const request = { url: 'https://fixture.invalid/infer', headers: {}, body: '{}' }
    let late, cancelled = false, timedSignal
    const stalled = make(async (_url, init) => {
      timedSignal = init.signal
      return new Promise(resolve => { late = resolve }) // deliberately ignores abort
    })
    await assert.rejects(stalled.sendEncrypted(request, options), error => error.code === 'TIMEOUT' && /响应头/.test(error.message))
    assert.equal(timedSignal.aborted, true)
    late(new Response(new ReadableStream({ cancel() { cancelled = true } })))
    await delay(0)
    assert.equal(cancelled, true, 'late bodies are cancelled even when a custom fetch ignores abort')

    const parent = new AbortController(), reason = new Error('fixture caller cancelled')
    const cancelledRequest = make(async () => { parent.abort(reason); return new Promise(() => {}) })
    await assert.rejects(cancelledRequest.sendEncrypted(request, { ...options, signal: parent.signal }), error => error === reason)
    let called = false
    await assert.rejects(make(async () => { called = true }).sendEncrypted(request,
      { ...options, signal: parent.signal }), error => error === reason)
    assert.equal(called, false, 'pre-aborted calls never send')

    const bodyParent = new AbortController()
    let responseSignal
    const successful = make(async (_url, init) => { responseSignal = init.signal; return answer() })
    const response = await successful.sendEncrypted(request, { ...options, signal: bodyParent.signal })
    await delay(40)
    assert.equal(responseSignal.aborted, false, 'headers clear the timer, preserving a long response body')
    bodyParent.abort(reason)
    assert.equal(responseSignal.aborted, true, 'parent cancellation still reaches the response body after headers')
    await response.body.cancel()
    console.log('ok  #931: bounded headers, caller abort, pre-abort, timer cleanup and late-body cancellation')
  } finally {
    QoderEncryptedInfer.create = create
    outletState.active = previousOutlet.active
    outletState.respond = previousOutlet.respond
    if (headersTimeout === undefined) delete process.env.DSH_QODER_HEADERS_TIMEOUT_MS
    else process.env.DSH_QODER_HEADERS_TIMEOUT_MS = headersTimeout
  }
}
