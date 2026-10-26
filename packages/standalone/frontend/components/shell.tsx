import { ChartColumn, ChevronRight, Cpu, Layers, LayoutDashboard, LogOut, Monitor, Moon, PlugZap, Settings, ShieldCheck, Sun, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { Button } from './ui'
import { stopThemeTicker } from '../theme.mjs'
import type { Host, Page, Summary } from '../types'

const navigation = [
  { label: '工作空间', items: [
    { id: 'overview', name: '概览', icon: LayoutDashboard },
    { id: 'models', name: '模型清单', icon: Cpu },
    { id: 'combos', name: '模型组', icon: Layers },
    { id: 'usage', name: '用量与路由', icon: ChartColumn },
    { id: 'logs', name: '请求日志', icon: Terminal },
  ] },
  { label: '渠道', items: [{ id: 'channels', name: '账号池', icon: PlugZap }] },
  { label: '管理', items: [{ id: 'settings', name: '服务设置', icon: Settings }] },
] as const

type Origin = { x: number; y: number }
type ThemeMode = 'light' | 'dark' | 'auto'
type ResolvedTheme = 'light' | 'dark'
const THEME_KEY = 'ofm-theme'

const readThemeMode = (): ThemeMode => {
  try { const saved = localStorage.getItem(THEME_KEY); if (saved === 'light' || saved === 'dark') return saved } catch { /* 存储不可用走默认档 */ }
  return 'auto'
}
// 自动档时间表：19:00–07:00 夜间主题，其余浅色（北京时间本地时钟，不依赖系统外观设置）。
const isNightTime = () => { const hour = new Date().getHours(); return hour >= 19 || hour < 7 }
const resolveTheme = (mode: ThemeMode): ResolvedTheme => mode === 'auto' ? (isNightTime() ? 'dark' : 'light') : mode
const applyTheme = (resolved: ResolvedTheme) => { document.documentElement.dataset.theme = resolved }

// 三档主题：白天 / 晚上 / 自动（按时间表实时切换）。档位持久化在 localStorage，
// 历史值只有 light/dark，天然映射为手动档；没存过即 auto（与 theme.mjs 开机脚本同一套规则）。
function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readThemeMode)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readThemeMode()))
  // 自动档每 30 秒自检时间表，跨档（19:00 / 07:00 界）时静默切换——
  // 不走 View Transition 扩散，避免用户正在看内容时屏幕突然转一圈。
  useEffect(() => {
    if (mode !== 'auto') return
    const tick = () => {
      const next = resolveTheme('auto')
      setResolved(previous => {
        if (previous === next) return previous
        applyTheme(next)
        return next
      })
    }
    tick()
    const timer = window.setInterval(tick, 30000)
    return () => window.clearInterval(timer)
  }, [mode])
  const apply = (next: ThemeMode) => {
    const target = resolveTheme(next)
    setMode(next); setResolved(target); applyTheme(target)
    try { localStorage.setItem(THEME_KEY, next) } catch { /* 存储不可用时仅本次会话生效 */ }
  }
  const switchTo = (next: ThemeMode, origin?: Origin) => {
    if (next === mode) return
    // 没有 View Transition、或用户要求减少动效时直接切换，不做扩散。
    if (!origin || typeof document.startViewTransition !== 'function'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(next); return }
    const root = document.documentElement
    // 半径取按钮中心到视口最远角的距离，保证圆盘一定盖满整屏。
    const radius = Math.hypot(Math.max(origin.x, window.innerWidth - origin.x), Math.max(origin.y, window.innerHeight - origin.y))
    root.style.setProperty('--theme-reveal-x', `${origin.x}px`)
    root.style.setProperty('--theme-reveal-y', `${origin.y}px`)
    root.style.setProperty('--theme-reveal-r', `${radius}px`)
    // 扩散期间关掉 300ms 的底色过渡，否则"新主题"快照会抓到过渡中间色。
    root.classList.add('theme-transitioning')
    const transition = document.startViewTransition(() => { flushSync(() => apply(next)) })
    const finish = () => {
      root.classList.remove('theme-transitioning')
      root.style.removeProperty('--theme-reveal-x')
      root.style.removeProperty('--theme-reveal-y')
      root.style.removeProperty('--theme-reveal-r')
    }
    transition.finished.then(finish, finish)
  }
  return { mode, resolved, switchTo }
}

const THEME_OPTIONS = [
  { id: 'light', label: '白天（浅色主题）', icon: Sun },
  { id: 'dark', label: '晚上（深色主题）', icon: Moon },
  { id: 'auto', label: '自动（19:00–07:00 夜间）', icon: Monitor },
] as const

// 顶栏右上角三态主题胶囊；切换动效沿用圆形扩散（圆心从所点分段起算）。
export function ThemeSwitch() {
  const { mode, switchTo } = useTheme()
  // React 挂载即停掉 theme.mjs 的模块级定时器：首屏主题由它兜底（防闪白），
  // 挂载后主题只由 useTheme 独家接管，否则启动脚本会按过时快照每 30 秒
  // 把用户手动选的「晚上」覆盖回「白天」。
  useEffect(() => { stopThemeTicker() }, [])
  return <div className="theme-switch" role="group" aria-label="主题：白天 / 晚上 / 自动">
    {THEME_OPTIONS.map(option => <button key={option.id} type="button"
      className={`theme-switch-btn ${mode === option.id ? 'is-active' : ''}`}
      aria-pressed={mode === option.id} aria-label={option.label} title={option.label}
      onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); switchTo(option.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) }}>
      <option.icon size={14} strokeWidth={1.8} />
    </button>)}
  </div>
}

export const pageNames: Record<Page, string> = {
  overview: '概览', models: '模型清单', combos: '模型组', usage: '用量与路由', logs: '请求日志', channels: '账号池',
  settings: '服务设置',
}

export function Sidebar({ page, summary, host }: { page: Page; summary?: Summary; host: Host }) {
  return <>
    <div className="workspace-switch"><span className="workspace-avatar"><ShieldCheck size={17} /></span>
      <span>个人工作空间</span>
    </div>
    <nav className="console-nav" aria-label="管理导航">{navigation.map(group => <div className="nav-group" key={group.label}>
      <span className="nav-group-label">{group.label}</span>
      {group.items.map(item => <button key={item.id} className={`console-nav-item ${page === item.id ? 'selected' : ''}`}
        aria-current={page === item.id ? 'page' : undefined} onClick={() => host.navigate(item.id)}>
        <span className="console-nav-indicator" aria-hidden="true" />
        <item.icon size={18} strokeWidth={1.7} /><span>{item.name}</span>
        {item.id === 'models' && <span className="count-badge">{summary?.catalog.length ?? '—'}</span>}
      </button>)}
    </div>)}</nav>
    {/* 页脚：状态 + 版本号独占一行居左，退出钮靠右（主题开关已上移顶栏）。 */}
    <div className="console-sidebar-footer">
      <div className="sidebar-foot-info"><span className="sidebar-foot-status"><span className="status-dot" />本地服务在线</span>
        <small>v{summary?.version ?? '—'}</small></div>
      <div className="sidebar-foot-actions">
        <Button variant="ghost" aria-label="退出管理" title="退出管理" onClick={() => { void host.logout().catch(host.error) }}><LogOut size={16} /></Button></div>
    </div>
  </>
}
export function Topbar({ page }: { page: Page }) {
  return <><div className="console-breadcrumb"><span>工作空间</span><ChevronRight size={14} /><strong key={page} className="console-breadcrumb-current">{pageNames[page]}</strong></div>
    <ThemeSwitch /></>
}
