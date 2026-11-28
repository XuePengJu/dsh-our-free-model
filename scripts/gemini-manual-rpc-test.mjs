import assert from 'node:assert/strict'

/** Run against the registered source RPC and its real account pool. */
export async function verifyGeminiManualRpc(call) {
  const savedFetch = globalThis.fetch
  const pendingResponses = [], created = []
  let exchanges = 0
  const claims = Buffer.from(JSON.stringify({ sub: 'manual-rpc-fixture', email: 'manual-rpc@example.invalid' })).toString('base64url')
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith('https://oauth2.googleapis.com/token')) return savedFetch(input, init)
    exchanges++
    assert.equal(new URLSearchParams(init.body).get('code'), 'fixture-code')
    return new Promise(resolve => pendingResponses.push(() => resolve(Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, id_token: `e30.${claims}.fixture` }))))
  }
  const start = async () => {
    const result = await call('account.create', { provider: 'gemini' })
    assert.equal(result.ok, true)
    const value = result.value
    created.push(value.accountId)
    const authorization = new URL(value.loginUrl)
    return { ...value, state: authorization.searchParams.get('state'), redirect: authorization.searchParams.get('redirect_uri') }
  }
  try {
    const login = await start()
    const before = exchanges
    for (const url of ['fixture-code', '?code=fixture-code', '?code=fixture-code&state=wrong', '?error=access_denied&state=wrong']) {
      const rejected = await call('account.completeLogin', { accountId: login.accountId, url })
      assert.equal(rejected.ok, false)
      assert.equal(rejected.error.code, 'bad-request')
      assert.deepEqual((await call('login.poll', { provider: 'gemini', accountId: login.accountId })).value, { done: false })
    }
    assert.equal((await call('account.completeLogin', { accountId: login.accountId, code: 'fixture-code' })).ok, false, 'bare-code payload aliases are not accepted')
    assert.equal(exchanges, before)
    const url = `${login.redirect}?code=fixture-code&state=${login.state}`
    assert.equal((await call('account.completeLogin', { accountId: login.accountId, url })).ok, true)
    assert.equal((await call('account.completeLogin', { accountId: login.accountId, url })).ok, false, 'replay is rejected while token exchange is still pending')
    for (let attempt = 0; attempt < 100 && pendingResponses.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(exchanges, before + 1)
    pendingResponses.shift()()
    let poll
    for (let attempt = 0; attempt < 100; attempt++) {
      poll = (await call('login.poll', { provider: 'gemini', accountId: login.accountId })).value
      if (poll.done) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(poll.done, true)
    assert.equal(poll.success, true)
    assert.equal((await call('account.completeLogin', { accountId: login.accountId, url })).ok, false, 'a completed flow has no reusable handle')

    const cancelled = await start()
    const beforeCancel = exchanges
    assert.equal((await call('account.delete', { accountId: cancelled.accountId })).ok, true)
    assert.equal((await call('account.completeLogin', { accountId: cancelled.accountId, url: `?code=fixture-code&state=${cancelled.state}` })).ok, false)
    assert.equal(exchanges, beforeCancel, 'deleting the placeholder cancels its authorization flow')
    console.log('ok Gemini manual RPC: missing/wrong/matching state, no bare code, replay, settlement and cancellation')
  } finally {
    for (const release of pendingResponses) release()
    for (const accountId of created) await call('account.delete', { accountId })
    globalThis.fetch = savedFetch
  }
}
