/** Gemini OAuth callbacks through real local listeners, with synthetic token responses. */
import assert from 'node:assert/strict'
import { startGeminiOAuthFlow, GeminiLoginCancelledError } from '../vendor/channel-pack/src/gemini-oauth.ts'

let exchanges = 0
const token = Buffer.from(JSON.stringify({ sub: 'fixture-user', email: 'fixture@example.invalid' })).toString('base64url')
const fetcher = async (_url, init) => {
  exchanges++
  assert.equal(new URLSearchParams(init.body).get('code'), 'fixture-code')
  return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, id_token: `e30.${token}.fixture` })
}
const details = flow => {
  const url = new URL(flow.loginUrl)
  return { state: url.searchParams.get('state'), callback: url.searchParams.get('redirect_uri') }
}
const callback = (flow, values) => {
  const url = new URL(details(flow).callback)
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  return url.href
}

for (const format of ['url', 'query']) {
  const flow = await startGeminiOAuthFlow({ fetcher, timeoutMs: 5000 })
  try {
    const { state } = details(flow)
    const before = exchanges
    for (const invalid of [
      'fixture-code', '?code=fixture-code', '?code=fixture-code&state=',
      '?code=fixture-code&state=wrong', '?error=access_denied&state=wrong',
      callback(flow, { code: 'fixture-code' }),
      callback(flow, { code: 'fixture-code', state: 'wrong' }),
      `https://unrelated.invalid/oauth-callback?code=fixture-code&state=${state}`,
      `?code=fixture-code&state=${state}&state=${state}`,
    ]) assert.throws(() => flow.submit(invalid), Error, 'missing/wrong/ambiguous state never settles the pending login')
    assert.equal(exchanges, before)
    const valid = format === 'url' ? callback(flow, { code: 'fixture-code', state }) : `?code=fixture-code&state=${state}`
    assert.equal(typeof flow.submit(valid).message, 'string')
    assert.throws(() => flow.submit(valid), Error, 'a callback cannot be replayed during token exchange')
    const credential = await flow.result
    assert.equal(credential.email, 'fixture@example.invalid')
    assert.equal(exchanges, before + 1)
    assert.throws(() => flow.submit(valid), Error, 'a settled flow cannot accept a callback')
  } finally { await flow.close() }
}

{
  const flow = await startGeminiOAuthFlow({ fetcher, timeoutMs: 5000 })
  try {
    const { state, callback: redirect } = details(flow)
    const wrong = await fetch(callback(flow, { error: 'access_denied', state: 'wrong' }))
    assert.equal(wrong.status, 400, 'an error callback must validate state before cancellation')
    const missing = await fetch(redirect + '?code=fixture-code')
    assert.equal(missing.status, 400)
    const good = await fetch(callback(flow, { code: 'fixture-code', state }))
    assert.equal(good.status, 200, 'wrong callbacks do not kill the valid pending flow')
    await flow.result
  } finally { await flow.close() }
}

{
  const flow = await startGeminiOAuthFlow({ fetcher, timeoutMs: 5000 })
  const valid = callback(flow, { code: 'fixture-code', state: details(flow).state })
  const before = exchanges
  const rejected = assert.rejects(flow.result, GeminiLoginCancelledError)
  await flow.close()
  await rejected
  assert.throws(() => flow.submit(valid), Error)
  assert.equal(exchanges, before, 'cancelled flows never exchange codes')
}

{
  const flow = await startGeminiOAuthFlow({ fetcher, timeoutMs: 5000 })
  const rejected = assert.rejects(flow.result, GeminiLoginCancelledError)
  assert.throws(() => flow.submit(`?error=access_denied&state=${details(flow).state}`), /Google/)
  await rejected
  await flow.close()
}

{
  let release
  const flow = await startGeminiOAuthFlow({ timeoutMs: 5000, fetcher: async () => {
    await new Promise(resolve => { release = resolve })
    return fetcher('', { body: 'code=fixture-code' })
  } })
  flow.submit(`?code=fixture-code&state=${details(flow).state}`)
  await new Promise(resolve => setImmediate(resolve))
  const rejected = assert.rejects(flow.result, GeminiLoginCancelledError)
  await flow.close()
  release()
  await rejected
}
console.log('Gemini manual callbacks: strict state, complete URL/query, wrong/missing/replay, HTTP parity, cancel and in-flight cancellation passed')
