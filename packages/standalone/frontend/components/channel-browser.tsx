import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CircleAlert, Network, Search, ShieldCheck } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { shared } from 'ofm-shared-client'
import { Button, Card, Input } from './ui'
import type { Summary } from '../types'

interface Status { closed?: boolean; accounts?: { total: number; enabled: number }; models?: { total: number; disabled: number } }
type Rpc = (method: string, payload?: object) => Promise<any>
const t = Object.assign((key: string) => shared.DICT.zh[key] ?? key, { locale: 'zh' })

/**
 * 渠道页主从布局：左侧 300px 常驻渠道列表（搜索 + 状态筛选 + 渠道行 + 统计/签到），
 * 右侧为选中渠道的即时管理详情。列表项整行可点、↑↓ 移动焦点、Esc 清空搜索；
 * 不再有「管理渠道 / 返回全部渠道」的跳转动线。
 */
export function ChannelBrowser({ rpc, summary }: { rpc: Rpc; summary: Summary & { reload?(): void } }) {
  const [statuses, setStatuses] = useState<Record<string, Status>>()
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [selected, select] = useState<string>()
  const [auto, setAuto] = useState<{ enabled: boolean; running?: boolean; ranToday?: boolean }>()
  const [busy, setBusy] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const mounted = useRef(false)
  const sequence = useRef(0)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 键盘（Enter/Space，event.detail===0）选中渠道时才把焦点交给详情标题播报锚点；
  // 鼠标点击不打断左列表焦点，↑↓ 连续导航不中断。
  const focusDetailOnSelect = useRef(false)
  const reload = useCallback(async () => {
    const started = ++sequence.current
    try {
      const value = await rpc('provider.status', { providers: providers.map(row => row.id) })
      if (!mounted.current || started !== sequence.current) return
      setStatuses(value.statuses ?? {})
      setError('')
    } catch (failure) {
      if (mounted.current && started === sequence.current) setError((failure as Error).message)
    }
  }, [rpc])
  useEffect(() => {
    mounted.current = true
    void reload()
    void rpc('usage.autoCheckin', {}).then(value => {
      if (mounted.current) setAuto(value.autoCheckin)
    }).catch(() => {})
    const timer = setInterval(() => { void reload() }, 45000)
    return () => { mounted.current = false; sequence.current++; clearInterval(timer) }
  }, [rpc, reload])
  const onChanged = useCallback(() => {
    void reload()
    window.dispatchEvent(new CustomEvent('ofm:channels'))
    summary.reload?.()
  }, [reload, summary.reload])
  const onError = useCallback((_provider: unknown, failure: Error) => { if (mounted.current) setError(failure.message) }, [])

  // 切换筛选/搜索后：选中项仍可见则保留，否则清空选中（可见性判定与下方 rows 一致）。
  useEffect(() => {
    if (selected === undefined) return
    const provider = providers.find(row => row.id === selected)
    if (!provider) { select(undefined); return }
    const status = statuses?.[provider.id]
    const connectedRow = (status?.accounts?.enabled ?? 0) > 0 && !status?.closed
    const matches = `${provider.name} ${provider.org}`.toLowerCase().includes(search.toLowerCase().trim())
      && (filter === 'all' || (status !== undefined && (filter === 'connected' ? connectedRow : !connectedRow)))
    if (!matches) select(undefined)
  }, [statuses, search, filter, selected])
  // 键盘选中后聚焦详情标题（tabIndex=-1 播报锚点，读屏播报渠道名），鼠标选中不抢焦点。
  useEffect(() => {
    if (!focusDetailOnSelect.current) return
    focusDetailOnSelect.current = false
    if (selected !== undefined) detailHeading.current?.focus({ preventScroll: true })
  }, [selected])

  // ===== 筛选与统计（standalone-channel-filter-test 会原样提取本段做纯函数校验：
  //       自 const connected = 起、至 return <> 止，须保持无 hooks 的自包含纯 JS） =====
  const connected = providers.filter(provider => {
    const status = statuses?.[provider.id]
    return (status?.accounts?.enabled ?? 0) > 0 && !status?.closed
  }).length
  const accounts = Object.values(statuses ?? {}).reduce((sum, row) => sum + (row.accounts?.total ?? 0), 0)
  const selectedProvider = providers.find(row => row.id === selected)
  const rows = providers.filter(provider => {
    const status = statuses?.[provider.id]
    const connectedRow = (status?.accounts?.enabled ?? 0) > 0 && !status?.closed
    return `${provider.name} ${provider.org}`.toLowerCase().includes(search.toLowerCase().trim())
      && (filter === 'all' || (status !== undefined && (filter === 'connected' ? connectedRow : !connectedRow)))
  })
  // 分类标签展示全量数量；搜索后的匹配数量由筛选 chips 自身展示。
  const counts: Record<string, number> = {
    all: providers.length,
    connected,
    pending: providers.filter(provider => {
      const status = statuses?.[provider.id]
      return status !== undefined && (status.closed || (status.accounts?.enabled ?? 0) <= 0)
    }).length,
  }
  const selectedStatus = selectedProvider ? statuses?.[selectedProvider.id] : undefined

  // 详情头「启用渠道」开关：已禁用渠道也能在这里直接启用。
  const toggleProvider = () => {
    if (!selectedProvider || enabling) return
    setEnabling(true)
    void rpc('provider.setEnabled', { provider: selectedProvider.id, enabled: selectedStatus?.closed === true })
      .then(() => { if (mounted.current) onChanged() })
      .catch(failure => { if (mounted.current) setError((failure as Error).message) })
      .finally(() => { if (mounted.current) setEnabling(false) })
  }

  // 主从容器键盘交互（挂在 .provider-master 上，搜索框/chips/列表内都生效）：
  // Esc 清空搜索（有内容时）；↑↓ 在渠道行之间移动焦点（Enter 为按钮原生选中），
  // 焦点在列表外（如搜索框）时 ↓ 进第一行、↑ 进最后一行。
  const onMasterKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (search !== '') setSearch('')
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = listRef.current
      ? Array.from(listRef.current.querySelectorAll<HTMLButtonElement>('.provider-master-item')) : []
    if (buttons.length === 0) return
    const index = buttons.findIndex(button => button === document.activeElement)
    // 焦点已在列表行内：行间移动；焦点在容器内其他元素（搜索框等）：跳进列表两端。
    if (index === -1) {
      if (listRef.current?.contains(document.activeElement)) return
      event.preventDefault()
      buttons[event.key === 'ArrowDown' ? 0 : buttons.length - 1]?.focus()
      return
    }
    event.preventDefault()
    const next = Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
    buttons[next]?.focus()
  }

  return <>
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span><Button variant="ghost" onClick={() => { void reload() }}>重试</Button></div>}
    <div className="provider-master" onKeyDown={onMasterKeyDown}>
      {/* ===== 左列表：搜索 + 状态筛选 chips + 渠道行 + 统计/签到 ===== */}
      <div className="provider-master-list">
        <div className="provider-master-head">
          <div className="channel-search"><Search size={17} /><Input aria-label="搜索渠道" placeholder="搜索渠道或供应商…" value={search}
            onChange={event => setSearch(event.target.value)} /></div>
          <div className="channel-filters" aria-label="渠道状态筛选">{[['all', '全部'], ['connected', '已接入'], ['pending', '待接入']].map(([id, label]) =>
            <button key={id} aria-pressed={filter === id} disabled={id !== 'all' && !statuses} onClick={() => setFilter(id)}>{label}<span>{id === 'all' || statuses ? counts[id] : '—'}</span></button>)}</div>
        </div>
        <div ref={listRef} className="provider-master-items" role="listbox" aria-label="渠道列表">
          {rows.map(provider => {
            const status = statuses?.[provider.id]
            const connectedRow = (status?.accounts?.enabled ?? 0) > 0 && !status?.closed
            return <button key={provider.id} role="option" aria-selected={provider.id === selected}
              className={`provider-master-item ${provider.id === selected ? 'selected' : ''}`}
              onClick={event => { focusDetailOnSelect.current = event.detail === 0; select(provider.id) }}>
              <span className="provider-logo" style={{ color: provider.accent, backgroundColor: `${provider.accent}0d` }}>{provider.name.slice(0, 2).toUpperCase()}</span>
              <span className="provider-master-item-name"><strong>{provider.name}</strong>
                <small>{status === undefined ? '读取中' : status.closed ? '已禁用' : connectedRow ? provider.org : '待接入'}</small></span>
              <span className="provider-master-item-count"><strong>{status ? status.accounts?.total ?? 0 : '—'}</strong>账号</span>
            </button>
          })}
        </div>
        <div className="provider-master-foot">
          <span className="provider-master-stats"><strong>{statuses ? connected : '—'}</strong> / {providers.length} 已接入 · <strong>{statuses ? accounts : '—'}</strong> 账号</span>
          <span className="checkin-control"><span className="status-dot" /><span>{auto?.running ? '签到进行中' : auto?.ranToday ? '今日签到已执行' : '每日签到'}</span>
            <button type="button" role="switch" aria-label="每日自动签到" aria-checked={auto?.enabled === true}
              className={`ui-switch ${auto?.enabled ? 'on' : ''}`} disabled={!auto || busy} onClick={() => {
                setBusy(true)
                void rpc('usage.autoCheckin', { enabled: !auto?.enabled }).then(value => { if (mounted.current) setAuto(value.autoCheckin) })
                  .catch(failure => { if (mounted.current) setError(failure.message) }).finally(() => { if (mounted.current) setBusy(false) })
              }}><span /></button>
          </span>
        </div>
      </div>
      {/* ===== 右详情：选中渠道的头部 + 账号管理卡 + 安全说明 ===== */}
      <div className="provider-master-detail" data-testid="provider-detail">
        {rows.length === 0 ? <Card className="channel-empty"><Search size={24} /><h2>没有匹配的渠道</h2><p>试试其他名称，或切换筛选条件。</p>
          <Button variant="outline" onClick={() => { setSearch(''); setFilter('all') }}>重置筛选</Button></Card>
          : selectedProvider ? <>
            <div className="provider-master-detail-head">
              <div className="provider-master-who">
                <span className="provider-logo" style={{ color: selectedProvider.accent, backgroundColor: `${selectedProvider.accent}0d` }}>{selectedProvider.name.slice(0, 2).toUpperCase()}</span>
                <div><h2 tabIndex={-1} ref={detailHeading}>{selectedProvider.name}</h2>
                  <small>{selectedProvider.org}{selectedProvider.note ? ` · ${selectedProvider.note}` : ''}</small></div>
              </div>
              <label className="provider-enable-toggle">
                <span>启用渠道</span>
                <button type="button" role="switch" aria-label={`启用或禁用渠道：${selectedProvider.name}`}
                  aria-checked={selectedStatus?.closed !== true} disabled={!statuses || enabling}
                  className={`ui-switch ${selectedStatus?.closed !== true ? 'on' : ''}`} onClick={toggleProvider}><span /></button>
              </label>
            </div>
            <shared.ChannelCard key={selectedProvider.id} channel={selectedProvider} status={selectedStatus} rpc={rpc} t={t} onChanged={onChanged} onError={onError} />
            <div className="detail-security-note">
              <ShieldCheck size={16} />
              <span>沿用原渠道的登录、续期与额度规则。账号备份和供应商设置位于「供应商与备份」。账号凭据保存在本机独立目录。</span>
            </div>
          </> : <Card className="channel-empty"><Network size={24} /><h2>选择一个渠道</h2><p>在左侧列表点选渠道，账号与额度管理会显示在这里。</p></Card>}
      </div>
    </div>
  </>
}
