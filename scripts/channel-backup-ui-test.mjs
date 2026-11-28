/** Offline callbacks from the actual plugin component, backed by the real backup source. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: fileURLToPath(url),
      }).outputText }
    }
    return nextLoad(url, context)
  },
})
const { exportBackup, importBackup } = await import('../vendor/channel-pack/src/backup.ts')
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { ChannelBackupTools,')
const defer = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
  : tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []
const text = tree => nodes(tree).flatMap(node => node.children.filter(value => typeof value === 'string')).join(' ')
const limit = 8 * 1024 * 1024
const token = JSON.stringify({ access_token: 'synthetic-backup-secret', custom_field: 'preserved' })
const initial = () => ({
  accounts: [{ id: 'fixture', provider: 'lobsterai', nickname: 'fixture', enabled: true,
    credentialRef: 'LOBSTERAI_ACCOUNT_FIXTURE', createdAt: 1, expiresAt: 1 }],
  disabledModels: { loomy: { 'fixture-model': true } }, permanentLocks: { loomy: true },
})

function backend({ failCredential = false } = {}) {
  let state = initial(), writes = 0
  const credentials = new Map([['LOBSTERAI_ACCOUNT_FIXTURE', token]])
  const credentialStore = {
    resolve: async ref => credentials.has(ref) ? { value: credentials.get(ref) } : undefined,
    set: async (ref, value) => {
      if (failCredential) throw new Error(token)
      writes++; credentials.set(ref, value)
    },
  }
  const pool = {
    getStateSnapshot: () => structuredClone(state), permanentLocksSnapshot: () => ({ ...state.permanentLocks }),
    async replaceAll(accounts, disabledModels, permanentLocks) {
      state = structuredClone({ accounts, disabledModels, permanentLocks: permanentLocks ?? state.permanentLocks })
    },
  }
  return {
    get state() { return structuredClone(state) }, get writes() { return writes }, credentials,
    async rpc(method, payload) {
      if (method === 'backup.export') return exportBackup(pool, credentialStore)
      assert.equal(method, 'backup.import')
      return importBackup(credentialStore, pool, payload.payload)
    },
    clear() { state = { accounts: [], disabledModels: {}, permanentLocks: {} }; credentials.clear() },
    dropCredentials() { credentials.clear() },
  }
}

function mount({ language = 'en', handle, enabled = true, confirm = () => true, clickFails = false } = {}) {
  const cells = [], cleanup = new Map(), timers = new Map(), downloads = [], revoked = [], calls = [], confirmations = []
  let cursor = 0, effects = [], record, timerId = 0, changed = 0, disposed = false, lateWrites = 0, pickerClicks = 0
  const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      if (type === 'input' && props?.type === 'file') props.ref.current = { click() { pickerClicks++ } }
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], value => {
        if (disposed) lateWrites++
        cells[index] = typeof value === 'function' ? value(cells[index]) : value
      }]
    },
    useRef: value => cells[cursor++] ??= { current: value },
    useMemo(fn, deps) {
      const index = cursor++
      if (!same(cells[index]?.deps, deps)) cells[index] = { deps, value: fn() }
      return cells[index].value
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps) },
    useEffect(fn, deps) {
      const index = cursor++
      if (!same(cells[index], deps)) { cells[index] = deps; effects.push({ index, fn }) }
    },
  }
  const window = {
    __ModuleLoader__: { load(value) { record = value } },
    confirm(message) { confirmations.push(message); return confirm() },
    localStorage: { getItem() { assert.fail('backup must not read localStorage') }, setItem() { assert.fail('backup must not write localStorage') } },
  }
  const urls = new Map()
  const urlApi = {
    createObjectURL(blob) { const url = `blob:fixture-${urls.size + revoked.length}`; urls.set(url, blob); return url },
    revokeObjectURL(url) { revoked.push(url); urls.delete(url) },
  }
  const document = { createElement(type) {
    assert.equal(type, 'a')
    return { click() {
      if (clickFails) throw new Error(token)
      downloads.push({ filename: this.download, url: this.href, blob: urls.get(this.href) })
    } }
  } }
  const timer = (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId }
  new Function('window', 'document', 'URL', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', source)(
    window, document, urlApi, timer, id => timers.delete(id), timer, id => timers.delete(id))
  const api = record.factory(() => react).__test
  const props = {
    enabled, t: key => api.DICT[language][key], onChanged: () => { changed++ },
    rpc: async (method, payload) => { calls.push({ method, payload }); return handle?.(method, payload) ?? {} },
  }
  const render = (component = api.ChannelBackupTools, value = props, fresh = false) => {
    if (fresh) { for (const fn of cleanup.values()) fn?.(); cleanup.clear(); cells.length = 0 }
    cursor = 0; effects = []
    const tree = component(value)
    for (const { index, fn } of effects) { cleanup.get(index)?.(); cleanup.set(index, fn()) }
    return tree
  }
  const button = kind => nodes(render()).find(node => node.type === 'button' && node.children.includes(props.t(`chan.backup.${kind}`)))
  const input = () => nodes(render()).find(node => node.type === 'input' && node.props.type === 'file')
  const file = (contents, size = Buffer.byteLength(contents)) => ({ size, async text() { return contents } })
  const change = selected => {
    const target = { files: selected ? [selected] : [], value: 'fixture.json' }
    const promise = input().props.onChange({ target })
    assert.equal(target.value, '', 'reset the chooser so the same file can be selected again')
    return promise
  }
  render()
  return { api, props, render, button, input, change, file, calls, downloads, revoked, confirmations, timers,
    text: () => text(render()), get changed() { return changed }, get pickerClicks() { return pickerClicks },
    get lateWrites() { return lateWrites },
    unmount() { disposed = true; for (const fn of cleanup.values()) fn?.(); cleanup.clear() },
    expireUrls() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn() } },
  }
}

const savedFetch = globalThis.fetch
globalThis.fetch = async () => assert.fail('backup tests may not use the network')
try {
  // This executes the existing namespace/backup format and rejected-input tests too.
  const { verifyChannelStorageCompatibility } = await import('./channel-storage-compat-test.mjs')
  await verifyChannelStorageCompatibility()

  {
    const data = backend(), before = data.state
    const app = mount({ handle: data.rpc })
    assert.match(app.text(), /plaintext sign-in credentials/)
    assert.match(app.text(), /8 MiB/)
    assert.match(app.text(), /do not upload, share or commit/)
    app.button('import').props.onClick()
    assert.equal(app.pickerClicks, 1)
    await app.button('export').props.onClick()
    assert.deepEqual(app.calls.map(call => call.method), ['backup.export'])
    assert.equal(app.downloads.length, 1)
    const download = app.downloads[0]
    assert.match(download.filename, /^ofm-channels-\d{4}-\d{2}-\d{2}\.json$/)
    assert.equal(download.blob.type, 'application/json')
    const payload = JSON.parse(await download.blob.text())
    assert.equal(payload.format, 'channel-pack/backup')
    assert.deepEqual(payload.accounts, before.accounts)
    assert.deepEqual(payload.disabledModels, before.disabledModels)
    assert.deepEqual(payload.permanentLocks, before.permanentLocks)
    assert.equal(payload.credentials.LOBSTERAI_ACCOUNT_FIXTURE, token)
    assert.equal(app.changed, 0, 'export is read-only')
    data.clear()
    await app.change(app.file(JSON.stringify(payload)))
    assert.deepEqual(data.state, before, 'actual exported file restores accounts, models and credit locks')
    assert.equal(data.credentials.get('LOBSTERAI_ACCOUNT_FIXTURE'), token, 'credential custom fields survive the round trip')
    assert.equal(app.changed, 1, 'only a successful import refreshes cards and channel status')
    assert.match(app.text(), /Imported 1 account\(s\) and 1 credential\(s\)/)
    assert.match(app.text(), /Expired accounts: 1/)
    assert.doesNotMatch(app.text(), /synthetic-backup-secret|custom_field|LOBSTERAI_ACCOUNT_FIXTURE/)
    assert.match(app.confirmations[0], /replaces.*does not merge/)
    assert.match(app.confirmations[0], /plaintext sign-in credentials/)
    assert.equal([...app.timers.values()][0].delay, 60_000)
    app.expireUrls()
    assert.deepEqual(app.revoked, [download.url])
    app.unmount()
    assert.equal(app.lateWrites, 0)
  }
  console.log('ok plugin backup: actual callback export/import round trip, safe notice, refresh and URL expiry')

  {
    const data = backend(), before = data.state
    const app = mount({ handle: data.rpc })
    await app.change(app.file('{"access_token":"synthetic-backup-secret", invalid'))
    assert.equal(app.calls.length, 0)
    assert.match(app.text(), /Unable to read the backup JSON/)
    assert.equal(nodes(app.render()).some(node => node.props.role === 'alert'), true)
    assert.doesNotMatch(app.text(), /synthetic-backup-secret/)
    assert.deepEqual(data.state, before)
    const payload = (await data.rpc('backup.export')).payload
    for (const invalid of [{ ...payload, format: 'foreign-data' }, { ...payload, version: 999 }, { ...payload, accounts: null }]) {
      await app.change(app.file(JSON.stringify(invalid)))
      assert.match(app.text(), /Account backup import failed/)
      assert.deepEqual(data.state, before, 'invalid backup cannot replace the existing account pool')
      assert.equal(data.writes, 0, 'invalid backup is rejected before credential writes')
      assert.equal(app.changed, 0)
      assert.equal(app.button('import').props.disabled, false)
    }
    const calls = app.calls.length
    await app.change({ size: limit + 1, text() { assert.fail('oversize must be rejected before reading') } })
    assert.equal(app.calls.length, calls)
    assert.match(app.text(), /exceeds 8 MiB/)
    await app.change(undefined)
    assert.deepEqual(data.state, before)
    app.unmount()
  }
  console.log('ok plugin backup: malformed JSON, invalid format/version/schema and oversize retain existing pool')

  for (const kind of ['export', 'import']) {
    const wait = defer(), data = backend(), payload = (await data.rpc('backup.export')).payload
    const app = mount({ handle: async (method, value) => { await wait.promise; return data.rpc(method, value) } })
    const start = () => kind === 'export' ? app.button('export').props.onClick() : app.change(app.file(JSON.stringify(payload)))
    const running = start()
    await start()
    await settle()
    const again = start()
    await again
    assert.equal(app.calls.length, 1, 'same-tick/repeated callbacks are synchronously guarded')
    assert.equal(app.button('export').props.disabled, true)
    assert.equal(app.button('import').props.disabled, true)
    assert.equal(app.input().props.disabled, true)
    assert.equal(app.button(kind).props['aria-busy'], 'true')
    app.button('import').props.onClick()
    assert.equal(app.pickerClicks, 0, 'a pending operation cannot open another chooser')
    wait.resolve()
    await running
    assert.equal(app.button(kind).props.disabled, false)
    app.unmount()
    assert.equal(app.revoked.length, app.downloads.length, 'unmount releases unexpired object URLs')
  }
  console.log('ok plugin backup: export/import repeated clicks, cross-operation busy guard and unmount URL cleanup')

  {
    const waiting = defer(), app = mount()
    let reads = 0
    const selected = { size: limit, async text() { reads++; return waiting.promise } }
    const pending = app.change(selected)
    await app.change(selected)
    assert.equal(reads, 1, 'file read is covered by the synchronous operation guard')
    assert.equal(app.calls.length, 0)
    waiting.resolve('{')
    await pending
    assert.match(app.text(), /Unable to read/)
    assert.equal(app.button('import').props.disabled, false)
    app.unmount()
  }

  {
    const data = backend(), payload = (await data.rpc('backup.export')).payload
    const cancelled = mount({ confirm: () => false, handle: data.rpc })
    await cancelled.change(cancelled.file(JSON.stringify(payload)))
    assert.equal(cancelled.calls.length, 0)
    assert.equal(cancelled.changed, 0)
    assert.equal(cancelled.button('import').props.disabled, false)
    cancelled.unmount()
    const failed = mount({ handle: () => { throw new Error(token) } })
    for (const kind of ['export', 'import']) {
      if (kind === 'export') await failed.button(kind).props.onClick()
      else await failed.change(failed.file(JSON.stringify(payload)))
      assert.match(failed.text(), /Account backup .* failed/)
      assert.doesNotMatch(failed.text(), /synthetic-backup-secret|custom_field/)
      assert.equal(failed.button(kind).props.disabled, false)
      assert.equal(failed.changed, 0)
    }
    failed.unmount()
    const brokenDownload = mount({ handle: data.rpc, clickFails: true })
    await brokenDownload.button('export').props.onClick()
    assert.equal(brokenDownload.revoked.length, 1, 'download exceptions release the created URL immediately')
    assert.match(brokenDownload.text(), /Account backup export failed/)
    brokenDownload.unmount()
    const large = mount({ handle: () => ({ payload: { credentials: 'x'.repeat(limit) } }) })
    await large.button('export').props.onClick()
    assert.equal(large.downloads.length, 0)
    assert.match(large.text(), /exceeds 8 MiB/)
    large.unmount()
  }
  console.log('ok plugin backup: file-read guard, cancel, sanitized RPC/download errors and export size limit')

  {
    const data = backend({ failCredential: true }), payload = (await data.rpc('backup.export')).payload
    data.clear()
    const partial = mount({ handle: data.rpc })
    await partial.change(partial.file(JSON.stringify(payload)))
    assert.equal(data.state.accounts.length, 1, 'retain the existing RPC semantics: skipped credential writes do not stop account restore')
    assert.equal(data.credentials.size, 0)
    assert.equal(partial.changed, 1)
    assert.match(partial.text(), /Imported 1 account\(s\) and 0 credential\(s\)/)
    assert.match(partial.text(), /accounts missing credentials: 1; skipped credentials: 1/)
    assert.match(partial.text(), /need to sign in again/)
    assert.doesNotMatch(partial.text(), /LOBSTERAI_ACCOUNT_FIXTURE|synthetic-backup-secret/)
    partial.unmount()
    const incomplete = backend()
    incomplete.dropCredentials()
    const warned = mount({ handle: incomplete.rpc })
    await warned.button('export').props.onClick()
    assert.match(warned.text(), /1 credential\(s\) could not be exported/)
    assert.doesNotMatch(warned.text(), /LOBSTERAI_ACCOUNT_FIXTURE/)
    warned.unmount()
  }
  console.log('ok plugin backup: actual skipped credential writes and missing export credentials remain explicit and count-only')

  for (const ending of ['unmount', 'transport-before-render', 'replace-rpc']) {
    const waiting = defer(), data = backend(), app = mount({ handle: () => waiting.promise })
    let transport = { connection: 'old' }
    app.props.rpc.transport = () => transport
    const running = app.button('export').props.onClick()
    if (ending === 'unmount') app.unmount()
    else if (ending === 'transport-before-render') transport = { connection: 'new' }
    else { app.props.rpc = async () => data.rpc('backup.export'); app.render() }
    waiting.resolve(await data.rpc('backup.export'))
    await running
    assert.equal(app.downloads.length, 0, 'abandoned requests cannot produce credential downloads')
    assert.equal(app.lateWrites, 0)
    if (ending !== 'unmount') { assert.equal(app.button('export').props.disabled, false); app.unmount() }
  }
  {
    const waiting = defer(), app = mount()
    let transport = { connection: 'old' }
    app.props.rpc.transport = () => transport
    const running = app.change({ size: 10, text: () => waiting.promise })
    transport = { connection: 'new' }
    waiting.resolve('{}')
    await running
    assert.equal(app.calls.length, 0, 'file selected on the previous transport cannot be imported into the replacement')
    assert.equal(app.confirmations.length, 0)
    app.unmount()
  }
  console.log('ok plugin backup: unmount and transport ownership fence late downloads and file reads')

  for (const language of ['zh', 'en']) {
    const data = backend(), app = mount({ language, handle: data.rpc })
    assert.match(app.text(), language === 'zh' ? /明文登录凭据/ : /plaintext sign-in credentials/)
    const payload = (await data.rpc('backup.export')).payload
    delete payload.credentials.LOBSTERAI_ACCOUNT_FIXTURE
    await app.change(app.file(JSON.stringify(payload)))
    assert.match(app.text(), language === 'zh' ? /缺失凭据账号 1 个/ : /accounts missing credentials: 1/)
    if (language === 'en') assert.doesNotMatch(app.text(), /\p{Script=Han}/u)
    app.unmount()
    const unavailable = mount({ language, enabled: false, handle: data.rpc })
    await unavailable.button('export').props.onClick()
    await unavailable.change(unavailable.file('{}'))
    assert.equal(unavailable.calls.length, 0)
    assert.equal(unavailable.button('export').props.disabled, true)
    unavailable.unmount()
  }
  {
    const app = mount()
    const tree = app.render(app.api.ChannelsPage, { t: app.props.t, ctx: {}, summary: { channels: { state: 'ready' } } }, true)
    const tools = nodes(tree).find(node => node.type === app.api.ChannelBackupTools)
    assert.ok(tools, 'the real plugin channel page must render the backup controls')
    assert.equal(tools.props.enabled, false, 'connection readiness gates page controls')
    app.unmount()
  }
  console.log('ok plugin backup: bilingual sensitive-file warnings, count-only import warning and page availability')
} finally {
  globalThis.fetch = savedFetch
  hooks.deregister()
}
