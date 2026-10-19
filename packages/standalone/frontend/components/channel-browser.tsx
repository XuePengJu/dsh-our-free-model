import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CircleAlert, Network, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { shared } from 'ofm-shared-client'
import { Button, Card, Input } from './ui'
import {
  CREDIT_LABELS, CREDIT_MODES, REGIONS, REGION_LABELS,
  activeFilterCount, countLabel, filterChannels, matchesChannel,
} from '../channel-filter-data.mjs'
import type { Summary } from '../types'

interface Status { closed?: boolean; accounts?: { total: number; enabled: number }; models?: { total: number; disabled: number } }
type Rpc = (method: string, payload?: object) => Promise<any>
const t = Object.assign((key: string) => shared.DICT.zh[key] ?? key, { locale: 'zh' })

/** 视图结果在组件侧的形状（.mjs 里的对象字面量类型偏窄，这里显式放宽到可索引）。 */
interface ChannelView {
  rows: typeof providers
  counts: Record<string, number>
  facets: { regions: Record<string, number>; credits: Record<string, number> }
  accounts: number
  connected: number
}

/**
 * 渠道页主从布局：左侧 300px 常驻渠道列表（搜索 + 状态筛选 + 地区/积分方式筛选 + 渠道行 + 统计/签到），
 * 右侧为选中渠道的即时管理详情。列表项整行可点、↑↓ 移动焦点、Esc 关面板/清空搜索；
 * 不再有「管理渠道 / 返回全部渠道」的跳转动线。
 */
export function ChannelBrowser({ rpc, summary }: { rpc: Rpc; summary: Summary & { reload?(): void } }) {
  const [statuses, setStatuses] = useState<Record<string, Status>>()
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [region, setRegion] = useState('all')
  const [creditModes, setCreditModes] = useState<string[]>([])
  const [panel, setPanel] = useState(false)
  const [selected, select] = useState<string>()
  const [auto, setAuto] = useState<{ enabled: boolean; running?: boolean; ranToday?: boolean }>()
  const [busy, setBusy] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const mounted = useRef(false)
  const sequence = useRef(0)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 筛选浮层的两个锚点：外部点击判定要把「触发器」也算作内部，
  // 否则点触发器时外部监听先关、触发器再开，面板会关不掉。
  const filterTrigger = useRef<HTMLButtonElement>(null)
  const filterPopover = useRef<HTMLDivElement>(null)
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

  // 切换筛选/搜索后：选中项仍可见则保留，否则清空选中（复用 matchesChannel，与列表同一判定）。
  useEffect(() => {
    if (selected === undefined) return
    const provider = providers.find(row => row.id === selected)
    if (!provider) { select(undefined); return }
    if (!matchesChannel(provider, { statuses, search, filter, region, creditModes })) select(undefined)
  }, [statuses, search, filter, region, creditModes, selected])
  // 键盘选中后聚焦详情标题（tabIndex=-1 播报锚点，读屏播报渠道名），鼠标选中不抢焦点。
  useEffect(() => {
    if (!focusDetailOnSelect.current) return
    focusDetailOnSelect.current = false
    if (selected !== undefined) detailHeading.current?.focus({ preventScroll: true })
  }, [selected])
  // 点击浮层外部关闭：面板打开时才挂监听，卸载即摘。
  // 用 pointerdown 而不是 click —— 点击落点若在被浮层遮挡的渠道行上，
  // click 会先触发那次「选中渠道」，面板还开着，用户会以为点空白处能选中。
  // pointerdown 抢在 click 之前关面板，落点语义就只剩「关掉它」。
  // 触发器自身排除在外：它的 onClick 负责开合，这里先关会导致面板永远打不开。
  useEffect(() => {
    if (!panel) return undefined
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (filterPopover.current?.contains(target)) return
      if (filterTrigger.current?.contains(target)) return
      setPanel(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [panel])

  // ===== 筛选与统计（判定与计数逻辑全部在 frontend/channel-filter-data.mjs，
  //       由 scripts/standalone-channel-filter-test.mjs 直接 import 做行为断言） =====
  const view = filterChannels(providers, { statuses, search, filter, region, creditModes }) as ChannelView
  const { rows, counts, facets } = view
  const accounts = view.accounts
  const connected = view.connected
  const selectedProvider = providers.find(row => row.id === selected)
  const selectedStatus = selectedProvider ? statuses?.[selectedProvider.id] : undefined
  const extraFilters = activeFilterCount({ region, creditModes })

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
  // Esc 先关筛选浮层（有则关），否则清空搜索（有内容时）；↑↓ 在渠道行之间移动焦点
  // （Enter 为按钮原生选中），焦点在列表外（如搜索框）时 ↓ 进第一行、↑ 进最后一行。
  const onMasterKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (panel) { setPanel(false); return }
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
      {/* ===== 左列表：搜索 + 状态筛选 chips + 更多筛选 + 渠道行 + 统计/签到 ===== */}
      <div className="provider-master-list">
        <div className="provider-master-head">
          <div className="channel-search"><Search size={17} /><Input aria-label="搜索渠道" placeholder="搜索渠道或供应商…" value={search}
            onChange={event => setSearch(event.target.value)} /></div>
          <div className="channel-filter-row">
            <div className="channel-filters" aria-label="渠道状态筛选">{[['all', '全部'], ['connected', '已接入'], ['pending', '待接入']].map(([id, label]) =>
              <button key={id} aria-pressed={filter === id} disabled={id !== 'all' && !statuses} onClick={() => setFilter(id)}>{label}<span>{countLabel(counts[id], statuses)}</span></button>)}</div>
            <button ref={filterTrigger} type="button" className={`channel-filter-trigger ${extraFilters > 0 ? 'on' : ''}`}
              aria-expanded={panel} aria-label="更多筛选" onClick={() => setPanel(value => !value)}>
              <SlidersHorizontal size={13} />筛选
              {extraFilters > 0 && <span className="channel-filter-badge">{extraFilters}</span>}
            </button>
            {panel && <div ref={filterPopover} className="channel-filter-popover" role="dialog" aria-label="渠道筛选">
              <div className="channel-filter-group">
                <div className="channel-filter-group-head"><span>地区</span><small>单选</small></div>
                <div className="channel-filter-options">
                  {REGIONS.map(option => {
                    const count = facets.regions[option.id]
                    const disabled = option.id !== 'all' && count === 0 && region !== option.id
                    return <button key={option.id} type="button" disabled={disabled} aria-pressed={region === option.id}
                      className={region === option.id ? 'on' : ''} onClick={() => setRegion(option.id)}>{option.label}<span>{count}</span></button>
                  })}
                </div>
              </div>
              <div className="channel-filter-group">
                <div className="channel-filter-group-head"><span>积分方式</span><small>可多选</small></div>
                <div className="channel-filter-options">
                  {CREDIT_MODES.map(option => {
                    const count = facets.credits[option.id]
                    const on = creditModes.includes(option.id)
                    const disabled = !on && count === 0
                    return <button key={option.id} type="button" disabled={disabled} aria-pressed={on} className={on ? 'on' : ''}
                      onClick={() => setCreditModes(current => current.includes(option.id) ? current.filter(mode => mode !== option.id) : [...current, option.id])}>{option.label}<span>{count}</span></button>
                  })}
                </div>
              </div>
              <div className="channel-filter-foot">
                <span>匹配 <strong>{rows.length}</strong> 个渠道</span>
                <button type="button" className="channel-filter-clear" onClick={() => { setRegion('all'); setCreditModes([]) }}>清空筛选</button>
              </div>
            </div>}
          </div>
        </div>
        <div ref={listRef} className="provider-master-items" role="listbox" aria-label="渠道列表">
          {rows.map(provider => {
            const status = statuses?.[provider.id]
            const connectedRow = (status?.accounts?.enabled ?? 0) > 0 && !status?.closed
            const creditText = (provider.creditModes ?? []).map(mode => (CREDIT_LABELS as Record<string, string>)[mode] ?? mode).join(' ')
            return <button key={provider.id} role="option" aria-selected={provider.id === selected}
              className={`provider-master-item ${provider.id === selected ? 'selected' : ''}`}
              onClick={event => { focusDetailOnSelect.current = event.detail === 0; select(provider.id) }}>
              <span className="provider-logo" style={{ color: provider.accent, backgroundColor: `${provider.accent}0d` }}>{provider.name.slice(0, 2).toUpperCase()}</span>
              <span className="provider-master-item-name"><strong>{provider.name}</strong>
                <small>{`${status === undefined ? '读取中' : status.closed ? '已禁用' : connectedRow ? provider.org : '待接入'}${creditText ? ` · ${creditText}` : ''}`}</small></span>
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
          <Button variant="outline" onClick={() => { setSearch(''); setFilter('all'); setRegion('all'); setCreditModes([]); setPanel(false) }}>重置筛选</Button></Card>
          : selectedProvider ? <>
            <div className="provider-master-detail-head">
              <div className="provider-master-who">
                <span className="provider-logo" style={{ color: selectedProvider.accent, backgroundColor: `${selectedProvider.accent}0d` }}>{selectedProvider.name.slice(0, 2).toUpperCase()}</span>
                <div><h2 tabIndex={-1} ref={detailHeading}>{selectedProvider.name}</h2>
                  <small>{selectedProvider.org}{selectedProvider.note ? ` · ${selectedProvider.note}` : ''} · {REGION_LABELS[selectedProvider.region]}</small></div>
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
