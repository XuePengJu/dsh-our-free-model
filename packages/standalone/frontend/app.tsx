import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { Sidebar, Topbar } from './components/shell'
import { Overview } from './components/overview'
import type { Combo, ComboDraft, Host, Page, ProbeProgress, ServiceSettings, Snapshot, UsageLedgerResponse, WorkbuddyBackup, WorkbuddySyncResult, WorkbuddyWriteResult } from './types'
import './app.css'

const API = '/api/management'
const pageNames: Page[] = ['overview', 'models', 'combos', 'usage', 'logs', 'channels', 'settings']
const platform = document.getElementById('root')?.dataset.loginPlatform ?? (/Windows/i.test(navigator.userAgent) ? 'windows' : /Macintosh|Mac OS/i.test(navigator.userAgent) ? 'macos' : 'unsupported')
const terminalName = platform === 'windows' ? 'PowerShell' : '终端'
type Request = <T = any>(path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal) => Promise<T>
const messageOf = (error: unknown) => error instanceof Error ? error.name === 'TimeoutError' ? '请求超时，请检查服务是否仍在运行。' : error.message : '请求失败，请重试。'

function LoginScreen({ request, auto = true }: { request: Request; auto?: boolean }) {
  const [key, setKey] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false)
  const signIn = async (value: string) => { if (busy) return; setBusy(true); setError(''); try { await request('/session', { key: value.trim() }); setKey(''); window.dispatchEvent(new CustomEvent('ofm:logged-in')) } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  // 令牌固定保存在本机数据目录，服务监听回环地址——打开登录页时直接向本机服务
  // 要一份自动填入并直接登录，省去用户翻文件、复制、点击的整套步骤；读取失败则保持手动流程。
  // 注意这里刻意不走 request 助手做 local-key 读取：页面加载时 summary/stats 的 401 会连续两次
  // enterLogin 使会话代际自增，自动填充的响应会撞上代际竞态而被误判丢弃。
  // 自动登录仍走 request 助手，但会针对「会话已变化」的竞态做短重试，等初始探测尘埃落定。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const response = await fetch('/api/management/local-key', { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) return
        const value = await response.json()
        if (!alive || typeof value?.key !== 'string' || value.key === '') return
        setKey(value.key)
        if (!auto) { setStatus('已自动填入本机令牌，直接点击「进入控制台」即可。'); return }
        setBusy(true); setStatus('正在使用本机令牌自动登录…')
        try {
          for (let attempt = 0; ; attempt++) {
            try { await request('/session', { key: value.key }); setKey(''); window.dispatchEvent(new CustomEvent('ofm:logged-in')); return }
            catch (reason) {
              if ((reason as { code?: string })?.code === 'stale-session' && attempt < 5) { await new Promise(resolve => setTimeout(resolve, 150)); continue }
              setError(messageOf(reason)); setStatus(''); return
            }
          }
        } finally { if (alive) setBusy(false) }
      } catch { /* 读取失败保持手动流程 */ }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const command = platform === 'windows'
    ? '(Get-Content -LiteralPath "$env:USERPROFILE\\.our-free-model\\settings.json" -Raw -Encoding UTF8 | ConvertFrom-Json).forwardKey | Set-Clipboard'
    : platform === 'macos'
      ? `node -e 'const fs = require("node:fs"); const {execFileSync} = require("node:child_process"); const key = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).forwardKey; if (typeof key !== "string" || !key.trim()) throw new Error("missing login token"); execFileSync("/usr/bin/pbcopy", [], {input: key});' "$HOME/.our-free-model/settings.json"`
      : `node -e 'const fs = require("node:fs"); const key = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).forwardKey; if (typeof key !== "string" || !key.trim()) throw new Error("missing login token"); process.stdout.write(key + "\\n");' "$HOME/.our-free-model/settings.json"`
  const submit = async (event: FormEvent) => { event.preventDefault(); await signIn(key) }
  const openTerminal = async () => { if (platform === 'unsupported' || busy) return; setBusy(true); setStatus(`正在本机打开${terminalName}…`); try { await request('/login/terminal', {}, 15000); setStatus(`已请求打开${terminalName}。窗口提示复制成功后，回到这里粘贴令牌。`); document.getElementById('login-key')?.focus() } catch (reason) { setStatus(`${messageOf(reason)}。可以展开下方的手动获取说明。`) } finally { setBusy(false) } }
  const copyCommand = async () => { try { await navigator.clipboard.writeText(command); setStatus(`命令已复制。在${terminalName}执行后，回到这里粘贴令牌。`) } catch { const input = document.getElementById('login-command') as HTMLTextAreaElement | null; input?.focus(); input?.select(); setStatus(`浏览器未允许复制，已选中命令，请按 ${platform === 'macos' ? 'Command+C' : 'Ctrl+C'} 手动复制。`) } }
  return <section id="login-screen" className="login-shell" data-testid="login-screen"><div className="login-card login-card-enter"><span className="login-card-glow" aria-hidden="true" /><div className="brand-mark" aria-hidden="true">ofm<span>.</span></div>
    <span className="eyebrow">OUR FREE MODEL / LOCAL CONSOLE</span><h1>连接你的本地服务</h1><p>已自动使用本机令牌登录；如退出或失败，可在此直接进入或改用一次性链接。</p>
    <form id="login-form" onSubmit={event => { void submit(event) }}><label htmlFor="login-key">登录令牌（API Key）</label><input id="login-key" name="key" type="password" autoComplete="off" placeholder="ofm-…" required value={key} onChange={event => setKey(event.target.value)} /><button className={"primary" + (busy ? " is-busy" : "")} type="submit" disabled={busy}>{busy && <span className="ui-spinner" aria-hidden="true" />}<span className="login-submit-label">进入控制台</span> <span aria-hidden="true">→</span></button></form>
    {error && <p id="login-error" role="alert" className="error login-error-enter">{error}</p>}<div className="login-help"><h2>没有令牌？从本机获取</h2><p id="login-terminal-help">{platform === 'unsupported' ? '当前系统不支持自动打开终端，请展开下方说明手动获取令牌。' : `点击下方按钮，会打开${terminalName}并将当前服务的令牌复制到剪贴板。回来粘贴到上方即可。`}</p>
      <button id="login-terminal" className="secondary" type="button" data-login-platform={platform} disabled={platform === 'unsupported' || busy} onClick={() => void openTerminal()}>打开{platform === 'windows' ? ' PowerShell ' : '终端'}获取令牌 ↗</button><p id="login-help-status" role="status">{status}</p><details><summary>手动获取与其他系统</summary><p>默认位置：用户目录下的 <code>.our-free-model/settings.json</code>，取 <code>forwardKey</code> 字段。</p><label id="login-command-label" htmlFor="login-command">获取令牌命令（默认目录）</label><textarea id="login-command" readOnly rows={4} spellCheck={false} value={command} /><button id="copy-login-command" className="text-button" type="button" onClick={() => void copyCommand()}>复制获取令牌命令</button></details></div><small>登录仅用于本机管理。会话在 8 小时后或服务重启后失效。</small></div></section>
}
function LoadingScreen() { return <div id="loading-screen" className="loading-screen"><div className="loading-inner"><div className="brand-mark loading-brand">ofm<span>·</span></div><span className="loading-bar" aria-hidden="true"><span className="loading-bar-fill" /></span><p>正在连接本地服务…</p></div></div> }
function ChannelMount({ summary }: { summary: Snapshot['summary'] & { reload(): void } }) {
  const [module, setModule] = useState<typeof import('./channels.mjs')>(); const generation = useRef(0); const summaryRef = useRef(summary); summaryRef.current = summary
  useEffect(() => { const current = ++generation.current; let alive = true; void import('./channels.mjs').then(value => { if (alive && current === generation.current) setModule(value) }); return () => { alive = false; generation.current++; module?.hide() } }, [])
  useEffect(() => { if (!module) return; module.show('channels', summaryRef.current); return () => module.hide() }, [module])
  return <div id="channel-root" className="ofm_root" role={module ? undefined : 'status'}>{module ? null : '正在加载渠道管理…'}</div>
}
// 请求日志独立页（顶层导航）：复用 channels.mjs 里的 LogsPage，自带独立 rpc 上下文，
// 不依赖渠道页的 requestLifetime（渠道页 hide() 会 abort 它）。
function LogsMount() {
  const [module, setModule] = useState<typeof import('./channels.mjs')>()
  useEffect(() => { let alive = true; void import('./channels.mjs').then(value => { if (alive) setModule(value) }); return () => { alive = false } }, [])
  return <div className="ofm_root" role={module ? undefined : 'status'}>{module ? <module.LogsMount /> : '正在加载请求日志…'}</div>
}
function LazyPage({ name, snapshot, host, active }: { name: 'models' | 'usage' | 'settings' | 'combos'; snapshot: Snapshot; host: Host; active: boolean }) {
  const [module, setModule] = useState<any>(); useEffect(() => { let alive = true; const loaded = name === 'models' ? import('./models') : name === 'usage' ? import('./usage') : name === 'combos' ? import('./combos') : import('./settings'); void loaded.then(value => { if (alive) setModule(value) }); return () => { alive = false } }, [name])
  if (!module) return <p role="status">正在加载页面…</p>; const Component = module[name === 'models' ? 'Models' : name === 'usage' ? 'Usage' : name === 'combos' ? 'Combos' : 'Settings']; return <Component summary={snapshot.summary} stats={snapshot.stats} host={host} active={active} />
}
function App() {
  const [mode, setMode] = useState<'loading' | 'login' | 'ready'>('loading'), [snapshot, setSnapshot] = useState<Snapshot>(), [page, setPage] = useState<Page>('overview'), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const [visited, setVisited] = useState<Page[]>([])
  const generation = useRef(0), loading = useRef<Promise<void> | undefined>(undefined), authenticated = useRef(false), settingsRevision = useRef(0), loggedOut = useRef(false)
  const enterLogin = (reason = '') => { generation.current++; loading.current = undefined; authenticated.current = false; setSnapshot(undefined); setVisited([]); setPage('overview'); setError(reason); setNotice(''); setMode('login') }
  const request: Request = async (path, body, timeoutMs = 10000, signal) => { const current = generation.current; const response = await fetch(API + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); const value = await response.json(); if (!response.ok) { const reason = Object.assign(new Error(value.error ?? `请求失败（${response.status}）`), { status: response.status }); if (current === generation.current && response.status === 401 && path !== '/session') enterLogin(reason.message); throw reason } if (current !== generation.current) throw Object.assign(new Error('管理会话已变化，请重新操作。'), { code: 'stale-session' }); return value }
  const loadData = async () => { if (loading.current) return loading.current; const current = generation.current, revision = settingsRevision.current; window.dispatchEvent(new CustomEvent('ofm:refresh-start')); const pending = Promise.all([request('/summary'), request('/stats')]).then(([summary, stats]) => { if (current !== generation.current) return; setSnapshot(previous => ({ summary: revision !== settingsRevision.current && previous ? { ...summary, settings: previous.summary.settings } : summary, stats })); authenticated.current = true; setMode('ready'); setError('') }).finally(() => { window.dispatchEvent(new CustomEvent('ofm:refresh-end')); if (loading.current === pending) loading.current = undefined }); loading.current = pending; return pending }
  const host = useMemo<Host>(() => ({ navigate: next => { if (pageNames.includes(next)) { setPage(next); setVisited(previous => previous.includes(next) ? previous : [...previous, next]); setError(''); setNotice('') } }, refresh: async () => { await loadData() }, copy: async value => { await navigator.clipboard.writeText(value); setNotice('已复制到剪贴板') }, getApiKey: async () => (await request<{ key: string }>('/key')).key, rotateKey: async () => (await request<{ key: string }>('/key/rotate', { confirm: true })).key, logout: async () => { loggedOut.current = true; await request('/logout', {}); enterLogin('已退出管理') }, error: reason => setError(messageOf(reason)), testModel: (model, signal) => request('/models/test', { model }, 330000, signal), refreshModels: async (probe, signal) => { await request('/models/refresh', { probe }, 300000, signal); if (!signal.aborted) await loadData() }, probeProgress: () => request<ProbeProgress>('/models/probe', undefined, 10000), setModelDisabled: async (id, disabled) => { await request('/models/disabled', { id, disabled }); await loadData() }, saveSettings: async (settings: Partial<ServiceSettings>) => { const value = await request<{ settings: ServiceSettings }>('/settings', settings); settingsRevision.current++; setSnapshot(previous => previous ? { ...previous, summary: { ...previous.summary, settings: value.settings } } : previous); return value.settings },
    listCombos: async () => (await request<{ combos: Combo[] }>('/combos', undefined, 15000)).combos,
    saveCombo: async (combo: ComboDraft) => { const value = await request<{ combos: Combo[] }>('/combos', combo, 15000); void loadData().catch(() => {}); return value.combos },
    deleteCombo: async (id: string) => { const value = await request<{ combos: Combo[] }>('/combos/delete', { id }, 15000); void loadData().catch(() => {}); return value.combos },
    syncCombosToWorkbuddy: async (baseUrl?: string, target?: 'ai') => await request<WorkbuddySyncResult>('/combos/export-workbuddy', { ...(baseUrl ? { baseUrl } : {}), ...(target ? { target } : {}) }, 30000),
    writeModelToWorkbuddy: async (id: string, baseUrl?: string, target?: 'ai') => await request<WorkbuddyWriteResult>('/models/export-workbuddy', { id, ...(baseUrl ? { baseUrl } : {}), ...(target ? { target } : {}) }, 30000),
    listWorkbuddyBackups: async () => (await request<{ backups: WorkbuddyBackup[] }>('/workbuddy/backups', undefined, 15000)).backups,
    restoreWorkbuddyBackup: async (file: string) => await request<{ restored: boolean; total: number; at: number }>('/workbuddy/backups/restore', { file }, 30000),
    // 渠道账本：**刻意不进 `loadData()` 的 `Promise.all`**。
    // 它要跨到 worker 线程走两个 RPC（`usage.tokenLedger` + `usage.tokenLedgerHistory`），
    // 是这一页最慢的一次往返；并进整包会让「渠道 worker 挂死」升级成
    // 「整张统计页白屏 + 5 秒一轮的 10 秒超时堆积」。账本自带独立时钟
    // （`usage.tsx` 内 6 秒），失败只降级明细表与实时流两块。
    // 超时给到 20 秒：默认的 10 秒对「账本刚满 500 条 + 冷启动 worker」偏紧。
    usageLedger: async (limit?: number) => await request<UsageLedgerResponse>(
      `/usage/ledger${Number.isFinite(limit) ? `?limit=${Math.trunc(limit as number)}` : ''}`,
      undefined,
      20000,
    ), }), [page])
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }) }, [page])
  useEffect(() => { const onUnauthorized = () => enterLogin('管理会话已失效，请重新登录'); window.addEventListener('ofm:unauthorized', onUnauthorized); return () => window.removeEventListener('ofm:unauthorized', onUnauthorized) }, [])
  useEffect(() => { const token = new URLSearchParams(location.hash.slice(1)).get('login'); if (token) history.replaceState(null, '', location.pathname + location.search); void (async () => { try { if (token) await request('/session', { bootstrapToken: token }); await loadData() } catch (reason) { enterLogin((reason as any)?.status === 401 && !token ? '' : messageOf(reason)) } })() }, [])
  useEffect(() => { if (mode !== 'ready') return; const timer = window.setInterval(() => { if (!document.hidden) void loadData().catch(reason => setError(messageOf(reason))) }, 5000); return () => window.clearInterval(timer) }, [mode])
  const content: ReactNode = snapshot && page === 'overview' ? <Overview {...snapshot} host={host} /> : snapshot && page === 'channels' ? <ChannelMount key={page} summary={{ ...snapshot.summary, reload: () => { void loadData() } }} /> : snapshot && page === 'logs' ? <LogsMount /> : null
  if (mode === 'loading') return <LoadingScreen />
  if (mode === 'login') return <LoginScreen request={async (...args) => { const result = await request(...args); if (args[0] === '/session') await loadData(); return result }} auto={!loggedOut.current} />
  return <div id="app" className="app-shell"><aside className="sidebar"><Sidebar page={page} summary={snapshot?.summary} host={host} /></aside><main><header className="topbar"><Topbar page={page} /></header>{snapshot?.summary.networkMode === 'fixture' && <div className="notice test-mode-notice notice-enter" role="alert">当前为本机替身测试模式：账号、模型回答与额度均为测试数据。</div>}{notice && <div className="notice notice-enter" role="status">{notice}<button className="text-button" onClick={() => setNotice('')}>关闭</button></div>}{error && <div className="notice error-notice notice-enter" role="alert"><AlertCircle size={16} /><span>{error}</span><button className="text-button" onClick={() => { setError(''); void loadData() }}>重试</button></div>}<section className="page">{content}{snapshot && (['models', 'combos', 'usage', 'settings'] as const).filter(name => visited.includes(name)).map(name => <div key={name} hidden={page !== name}><LazyPage name={name} snapshot={snapshot} host={host} active={page === name} /></div>)}</section><footer>OUR FREE MODEL <span>·</span> 本地运行 · 由你掌控</footer></main></div>
}
createRoot(document.getElementById('root')!).render(<App />)
