import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
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
/**
 * 单个渠道的自动签到状态（服务端 `usage.autoCheckin` 的 `providers[]`）。
 *
 * `time` 是 UTC+8 的 `HH:mm` 墙上时间 —— 原样显示，**不做本机时区换算**
 *（服务端按 UTC+8 结算，这里换算会让显示的时间与实际执行时间对不上）。
 */
interface AutoProviderState {
  provider: string
  enabled: boolean
  time: string
  ranToday: boolean
  lastResult: string
  lastAt: number
  /** 该渠道能否自动签到（无签到接口 / 代价过高的为 false，界面置灰）。 */
  supported: boolean
  running: boolean
}
/** 与服务端 `AUTO_CHECKIN_TIME_RE` 同一形状（24 小时制，各两位）。 */
const AUTO_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
/**
 * 默认签到时间，与服务端 `DEFAULT_AUTO_CHECKIN_TIME` 保持一致。
 *
 * ⚠️ 两份字面量是**刻意**的（与服务端 `AUTO_CHECKIN_TIME_RE` 同理）：前端要在
 * 未配置的渠道上先渲染出一个合理值，不可能为此打一次 RPC。漂移的后果只是
 * 「第一次打开时显示的时间与服务端默认值不同」，保存后即被服务端值覆盖 ——
 * 不会造成错误行为，故不值得为它建共享常量。
 */
const DEFAULT_AUTO_TIME = '10:05'
/**
 * 该渠道能否自动签到。
 *
 * ⚠️ 判据是 `creditModes` 含 `'daily'`（客户端能力表），**外加**排除 zcode：
 * zcode 有签到接口，但每次领取要现场产阿里云 captcha（web 版会拉起一个
 * headful Chromium 进程树，且阿里云按设备限流）。服务端 `supportsAutoCheckin()`
 * 有同一份判据，两处必须一致 —— 前端只是提前把控件置灰，服务端仍会拒绝写入。
 */
function supportsCheckin(provider: string): boolean {
  if (provider === 'zcode') return false
  const row = providers.find(entry => entry.id === provider)
  return Array.isArray(row?.creditModes) && row.creditModes.includes('daily')
}
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
  // 逐渠道自动签到状态（键 = 渠道 id）。⚠️ 只有**配置过**的渠道会出现在这里，
  // 未配置的按「默认关闭 + 默认时间」渲染，见 autoOf()。
  const [autoProviders, setAutoProviders] = useState<Record<string, AutoProviderState>>({})
  // 时间输入框的本地回显（键 = 渠道 id）：RPC 是防抖的，受控值若直接绑服务端
  // 回显，每敲一个字符都会被上一轮回显打回去，输入框看起来「打不进去」。
  const [timeDrafts, setTimeDrafts] = useState<Record<string, string>>({})
  const timeSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
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
  /** 拉取逐渠道签到状态（面板与渠道行都用它）。 */
  const loadAuto = useCallback(async () => {
    try {
      const value = await rpc('usage.autoCheckin', {})
      if (!mounted.current) return
      const list: AutoProviderState[] = Array.isArray(value?.autoCheckin?.providers) ? value.autoCheckin.providers : []
      const next: Record<string, AutoProviderState> = {}
      for (const entry of list) next[entry.provider] = entry
      setAutoProviders(next)
    } catch { /* 状态读取失败不打断页面：控件按「默认关闭」渲染 */ }
  }, [rpc])
  useEffect(() => {
    mounted.current = true
    void reload()
    void loadAuto()
    const timer = setInterval(() => { void reload() }, 45000)
    return () => {
      mounted.current = false
      sequence.current++
      clearInterval(timer)
      for (const timer of Object.values(timeSaveTimers.current)) clearTimeout(timer)
      timeSaveTimers.current = {}
    }
  }, [rpc, reload, loadAuto])
  /**
   * 取某渠道的签到状态。
   *
   * ⚠️ 服务端只回**配置过**的渠道（`state()` 是同步的，读不到账号池）。未配置的
   * 渠道要按「默认关闭 + 默认 10:05」渲染，否则用户点开一个从没配过的渠道会看到
   * 空白，误以为功能坏了。`supported` 由前端按 `creditModes` 判（见 supportsCheckin）。
   */
  const autoOf = useCallback((provider: string): AutoProviderState => {
    const known = autoProviders[provider]
    if (known !== undefined) return known
    return {
      provider,
      enabled: false,
      time: DEFAULT_AUTO_TIME,
      ranToday: false,
      lastResult: '',
      lastAt: 0,
      supported: supportsCheckin(provider),
      running: false,
    }
  }, [autoProviders])
  /**
   * 写某渠道的开关。
   *
   * ⚠️ 不用 `!auto.enabled` 取反再发：那会拿**渲染时**的旧值去翻转，连点两次
   * 可能发出两个相同的值（用户看到「点了没反应」）。这里显式传目标值。
   */
  const setAutoEnabled = useCallback(async (provider: string, enabled: boolean) => {
    setBusy(true)
    try {
      const value = await rpc('usage.autoCheckin', { provider, enabled })
      if (mounted.current) setAutoProviders(prev => ({ ...prev, [provider]: value.autoCheckin.providers.find((row: AutoProviderState) => row.provider === provider) ?? prev[provider] }))
    } catch (failure) {
      if (mounted.current) setError(`自动签到设置失败：${(failure as Error).message}`)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [rpc])
  const saveAutoTime = useCallback(async (provider: string, value: string) => {
    if (!AUTO_TIME_RE.test(value)) return
    try {
      const result = await rpc('usage.autoCheckin', { provider, time: value })
      if (!mounted.current) return
      const next = result.autoCheckin.providers.find((row: AutoProviderState) => row.provider === provider)
      if (next !== undefined) setAutoProviders(prev => ({ ...prev, [provider]: next }))
    } catch (failure) {
      if (mounted.current) setError(`签到时间保存失败：${(failure as Error).message}`)
    }
  }, [rpc])
  const onTimeChange = useCallback((provider: string, event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    setTimeDrafts(prev => ({ ...prev, [provider]: value }))
    // `<input type="time">` 每滚一格、每按一次方向键都会触发 change，
    // 而每次保存是一次落盘 + 服务端重新排期，必须防抖。
    const existing = timeSaveTimers.current[provider]
    if (existing !== undefined) clearTimeout(existing)
    timeSaveTimers.current[provider] = setTimeout(() => {
      // 先删掉再 await：这样保存返回后草稿才会被服务端回显认领。
      delete timeSaveTimers.current[provider]
      void saveAutoTime(provider, value)
    }, 600)
  }, [saveAutoTime])
  const timeOf = useCallback((provider: string): string => {
    const draft = timeDrafts[provider]
    if (draft !== undefined && draft !== '') return draft
    return autoOf(provider).time
  }, [timeDrafts, autoOf])
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
  /** 已开启自动签到的渠道数（左栏底部汇总用）。 */
  const autoOnCount = Object.values(autoProviders).filter(entry => entry.enabled === true).length
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
          {/* 自动签到已改成**逐渠道**（2026-10-24）：控件挪到右栏该渠道的详情里，
              这里只留一个汇总，告诉用户总共开了几个渠道，不用逐个点开去数。 */}
          {autoOnCount > 0 ? <span className="checkin-summary" title="自动签到已开启的渠道数">
            <span className="status-dot" />{autoOnCount} 个渠道自动签到
          </span> : null}
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
            {/*
              每日自动签到（**按渠道**，2026-10-24 改造）。
              ⚠️ 放在渠道详情里而不是页面顶部：自动签到的语义是「这个渠道要不要每天
              自动领积分」，只有落到具体渠道上才有意义。全局开关无法表达「Qoder 要签、
              WorkBuddy 国际版不要」，用户原话：「如果是全局的话，我不清楚你要对哪个
              渠道进行签到」。
            */}
            {(() => {
              const auto = autoOf(selectedProvider.id)
              const canAuto = auto.supported
              const on = canAuto && auto.enabled
              return <div className={`auto-checkin${canAuto ? '' : ' disabled'}`} data-testid="auto-checkin">
                <div className="auto-checkin-main">
                  <span className="auto-checkin-label">每日自动签到</span>
                  {canAuto ? <>
                    {/* 时间输入只在开关打开时出现：关着的引擎没有「下次执行」，
                        摆一个时间在旁边会读成「它仍会在 10:05 触发」。 */}
                    {on ? <label className="auto-checkin-time">
                      <span>每天</span>
                      <input type="time" className="auto-checkin-time-input"
                        aria-label={`${selectedProvider.name} 每日自动签到时间（UTC+8）`}
                        value={timeOf(selectedProvider.id)}
                        onChange={event => onTimeChange(selectedProvider.id, event)}
                        title="24 小时制，UTC+8 时区" />
                      <span>签到</span>
                    </label> : null}
                    <button type="button" role="switch" aria-label={`每日自动签到：${selectedProvider.name}`}
                      aria-checked={on} disabled={busy}
                      className={`ui-switch ${on ? 'on' : ''}`}
                      onClick={() => void setAutoEnabled(selectedProvider.id, !on)}><span /></button>
                  </> : null}
                </div>
                <div className="auto-checkin-note">
                  {canAuto
                    ? (auto.running
                      ? '签到进行中…'
                      : on
                        ? (auto.ranToday ? `今日已自动签到${auto.lastResult ? `：${auto.lastResult}` : ''}` : `今日将于 ${auto.time} 自动签到（UTC+8）`)
                        : '该渠道支持每日签到，打开开关后按设定时间自动领取')
                    : '该渠道不支持每日签到'}
                </div>
              </div>
            })()}
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
