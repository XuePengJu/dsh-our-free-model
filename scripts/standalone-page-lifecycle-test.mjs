import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// This suite compiles the TSX page source in-process, so it needs esbuild — a
// `packages/standalone` devDependency. The offline CI job installs nothing by
// design (see .github/workflows/test.yml), so the check skips when the compiler
// is absent, the same way the release-preparation suite skips its Windows-only
// symlink check. Locally, where the devDependency is installed, it runs.
let transformSync
try {
  const standaloneRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
  ;({ transformSync } = standaloneRequire('esbuild'))
} catch {
  console.log('ok  standalone-page-lifecycle skipped: esbuild is not installed (the offline job installs nothing)')
  process.exit(0)
}

const source = fs.readFileSync(new URL('../packages/standalone/frontend/app.tsx', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('function App()'), source.indexOf('createRoot(document'))
const slots = [], effects = []
let index = 0
const react = {
  useState(initial) { const at = index++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }] },
  useRef(value) { const at = index++; return slots[at] ??= { current: value } },
  useMemo(factory) { index++; return factory() },
  useEffect(effect, deps) { const at = index++, previous = slots[at]; if (previous?.deps?.length === deps?.length && deps?.every((value, i) => value === previous.deps[i])) return; slots[at] = { deps }; effects.push(effect) },
}
const settings = { enabled: true }
const summary = { settings, catalog: [], networkMode: 'fixture' }
const context = {
  ...react, h: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), Fragment: 'fragment',
  Sidebar: 'Sidebar', Topbar: 'Topbar', SponsorNotice: 'SponsorNotice', Overview: 'Overview', Connection: 'Connection', ChannelMount: 'ChannelMount', LazyPage: 'LazyPage', LoadingScreen: 'LoadingScreen', LoginScreen: 'LoginScreen', AlertCircle: 'AlertCircle',
  // 必须与 app.tsx 的 pageNames 保持一致：'eac' 与 'connection' 已并入 channels，
  // 桩里若仍列着它们，navigate('eac') 会被接受、page 变成一个没有 content 分支的
  // 值，界面直接白屏 —— 测试会误报成实现的问题。
  pageNames: ['overview', 'models', 'combos', 'usage', 'logs', 'channels', 'settings'], API: '/api/management',
  messageOf: error => error.message, AbortSignal, URLSearchParams, location: { hash: '' }, history: {},
  // loadData 会在开头/结尾 dispatch 一对 ofm:refresh-start/end 事件给顶部进度条。
  // 桩里没有 dispatchEvent 也没有 CustomEvent 时，loadData 第一步就抛错，
  // mode 永远停在 loading —— 于是下面的 Sidebar 查找拿到 undefined。
  // 事件本身不参与断言，提供空实现即可。
  window: {
    scrollTo() {}, addEventListener() {}, removeEventListener() {},
    setInterval() { return 1 }, clearInterval() {},
    dispatchEvent() { return true },
  },
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail } },
  document: { hidden: false }, navigator: { clipboard: { writeText: async () => {} } },
  fetch: async url => ({ ok: true, json: async () => url.endsWith('/summary') ? summary : { models: [], days: [] } }),
}
vm.createContext(context)
vm.runInContext(transformSync(code + '\nglobalThis.testApp = App', { loader: 'tsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code, context)
const render = () => { index = 0; return context.testApp() }
const all = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(all)] : []
const flush = async () => { for (const effect of effects.splice(0)) effect(); await new Promise(resolve => setImmediate(resolve)) }
render(); await flush()
let tree = render()
const host = () => all(tree).find(node => node.type === 'Sidebar').props.host
host().navigate('settings'); tree = render()
assert.ok(all(tree).some(node => node.type === 'LazyPage' && node.props.name === 'settings'))
host().navigate('models'); tree = render()
assert.ok(all(tree).some(node => node.type === 'LazyPage' && node.props.name === 'settings' && node.props.active === false), '切页后保留设置组件及草稿，但停止非活动页面任务')
assert.ok(all(tree).some(node => node.type === 'LazyPage' && node.props.name === 'models' && node.props.active === true))
host().navigate('usage'); tree = render()
assert.ok(all(tree).some(node => node.type === 'LazyPage' && node.props.name === 'models' && node.props.active === false), '模型筛选状态在切页后保留')
assert.ok(!all(tree).some(node => node.type === 'Connection'), '密钥页面离开后卸载，清除显示的密钥')
host().navigate('channels'); tree = render()
assert.equal(all(tree).find(node => node.type === 'ChannelMount').props.key, 'channels', '账号渠道使用独立嵌套根容器')
// EAC 已并入 channels 页，pageNames 里不再有 'eac'。导航到已废弃的页面名必须被
// 忽略（而不是把 page 置成一个不存在的值，让 content 变 null 白屏），容器 key
// 保持在 channels —— 这正是「换页时更换容器、避免旧 React 根覆盖新页面」的反面。
host().navigate('eac'); tree = render()
assert.equal(all(tree).find(node => node.type === 'ChannelMount').props.key, 'channels', '已废弃页面名被忽略，容器不换')
assert.ok(all(tree).some(node => node.type === 'ChannelMount'), '忽略废弃页面名后仍停留在账号渠道页')
let releaseOldKey
context.fetch = async url => url.endsWith('/key') ? new Promise(resolve => { releaseOldKey = resolve }) : { ok: true, json: async () => ({}) }
const oldKey = host().getApiKey().catch(error => error)
await host().logout(); tree = render()
assert.equal(tree.type, 'LoginScreen')
context.fetch = async url => ({ ok: true, json: async () => url.endsWith('/summary') ? summary : { models: [], days: [] } })
await tree.props.request('/session', { key: 'test' }); tree = render()
assert.equal(tree.props.id, 'app')
releaseOldKey({ ok: false, status: 401, json: async () => ({ error: '旧会话已过期' }) })
await oldKey; tree = render()
assert.equal(tree.props.id, 'app', '旧会话迟到 401 不得登出新会话')
console.log('ok  切页保留设置草稿与模型筛选，非活动页面暂停任务，退出移除工作空间')
