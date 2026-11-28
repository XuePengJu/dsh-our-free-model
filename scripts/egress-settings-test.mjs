/** Persisted subscription refresh settings through the real plugin HTTP routes. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callRoute, fakeContext, stubUpstream, until } from './lib/fake-kernel.mjs'

function verifyEgressUi() {
  let record, cursor = 0
  const cells = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment', useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
    useRef: initial => cells[cursor++] ??= { current: initial },
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
    },
  }
  const window = { __ModuleLoader__: { load: value => { record = value } } }
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace('exports.__test = {', 'exports.__test = { Egress,')
  new Function('window', source)(window)
  const { Egress, DICT } = record.factory(() => react).__test
  const saved = []
  const props = { settings: { egress: {} }, t: key => DICT.en[key], onApply: value => saved.push(value), busy: false }
  const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
    : tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []
  const render = () => { cursor = 0; return nodes(Egress(props)) }
  const field = () => render().find(node => node.type === 'input' && node.props.type === 'number')
  assert.equal(field().props.value, 86400)
  assert.equal(field().props.min, 60)
  assert.equal(field().props.max, 604800)
  field().props.onChange({ target: { value: '3600' } })
  render().find(node => node.children.includes('Apply')).props.onClick()
  assert.equal(saved.at(-1).egress.subscriptionIntervalSeconds, 3600)
  assert.equal(saved.at(-1).egress.url, undefined, 'editing cadence must not clear a secret URL that was never sent to the browser')
  render().find(node => node.props.label === DICT.en['egress.modeSubscription']).props.onChange()
  assert.equal(field(), undefined, 'direct-proxy mode has no subscription field')
  render().find(node => node.children.includes('Apply')).props.onClick()
  assert.equal(saved.at(-1).egress.subscriptionIntervalSeconds, undefined, 'direct mode preserves the stored subscription preference')
}
verifyEgressUi()

const upstream = await stubUpstream({ listing: ['deepseek-v4-flash-free'] })
process.env.OUR_FREE_MODEL_BASE = upstream.base
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-egress-settings-'))
process.env.DSH_HOME = home
const dataDir = path.join(home, 'our-free-model')
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ distribution: 'managed', combos: [], egress: { enabled: false, mode: 'subscription', url: 'https://fixture.invalid/PRIVATE' } }))
const { apply, inject } = await import('../index.js')
const routes = [], ctx = fakeContext({ inject, onRegister: route => routes.push(route) })
apply(ctx, {})
try {
  await until(() => routes.some(route => route.kind === 'prefix'), { timeoutMs: 5000, what: 'egress settings API' })
  const handler = routes.find(route => route.kind === 'prefix').handler
  const summary = async () => (await callRoute(handler, 'GET', '/api/our-free-model/summary')).json
  assert.equal((await summary()).settings.egress.subscriptionIntervalSeconds, 86400)
  for (const value of [60, 7200, 604800]) {
    const result = await callRoute(handler, 'POST', '/api/our-free-model/settings', { egress: { subscriptionIntervalSeconds: value } })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal(result.json.settings.egress.subscriptionIntervalSeconds, value)
    assert.equal((await summary()).settings.egress.subscriptionIntervalSeconds, value)
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
    assert.equal(saved.egress.subscriptionIntervalSeconds, value)
    assert.equal(saved.egress.url, 'https://fixture.invalid/PRIVATE')
    assert.ok(!JSON.stringify(result.json).includes('PRIVATE'), 'subscription credentials stay private')
  }
  for (const value of [null, '7200', 59, 604801, 60.5, '60\nrules: []']) {
    const before = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')
    const rejected = await callRoute(handler, 'POST', '/api/our-free-model/settings', { egress: { subscriptionIntervalSeconds: value } })
    assert.equal(rejected.status, 400, JSON.stringify(rejected.json))
    assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), before, 'invalid values cannot partially save')
  }
  console.log('egress settings: default, custom bounds, disk persistence, refreshed summary, secret masking and invalid-value atomicity passed')
} finally {
  for (const dispose of ctx.__disposers.reverse()) dispose()
  await upstream.close()
  fs.rmSync(home, { recursive: true, force: true })
}
