import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { Boxes, Check, CircleAlert, CircleCheck, Copy, Eye, EyeOff, LoaderCircle, MoreHorizontal, Play, Power, RefreshCw, Search, SlidersHorizontal, Square, Upload, X } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { Badge, Button, DropdownMenu, Input } from './components/ui'
import { EndpointStrip } from './components/endpoint-strip'
import { resolveEndpointBase } from './endpoint-origin'
import { filterModels, nextHiddenIds } from './models-data.mjs'
import { visibilityCopy } from './visibility-data.mjs'
import type { Host, Model, ModelTestResult, ProbeProgress, ServiceSettings, Summary } from './types'
import './models.css'

const availabilityNames: Record<string, string> = {
  available: '已探测可用', listed: '清单已收录', unknown: '未探测',
  unavailable: '不可用', throttled: '限流中', 'region-blocked': '地区受限',
  'needs-login': '需重新登录',
}
/** 需要用户动作/会挡住调用的状态：徽章用警示色。 */
const warningStates = ['unavailable', 'throttled', 'region-blocked', 'needs-login']
const sourceNames: Record<string, string> = { anonymous: '匿名模型', kilo: 'Kilo 免费池', eac: 'EAC 协付', combo: '模型组' }
const channelName = (id: string) => sourceNames[id]
  ?? providers.find(provider => provider.id === id)?.name ?? id
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value)
const capacity = (value?: number) => value && Number.isFinite(value) && value > 0
  ? value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : number(value) : '未知'
// 默认视图是「已探测可用」：快捷标签组与该默认值联动，六个标签是互斥视图，
// 各自完整决定 access × availability × disabled × hidden 四个维度（用下拉自由组合时无标签高亮）。
// 「已禁用」「已隐藏」都是独立一页：这两类模型不在其余任何视图出现，避免点了隐藏看不出变化。
const views = [
  { id: 'all', name: '全部模型', patch: { access: 'all', availability: 'all', disabled: 'active', hidden: 'active' } },
  { id: 'available', name: '已探测可用', patch: { access: 'all', availability: 'available', disabled: 'active', hidden: 'active' } },
  { id: 'routable', name: '可接入', patch: { access: 'routable', availability: 'all', disabled: 'active', hidden: 'active' } },
  { id: 'hidden', name: '未公开', patch: { access: 'hidden', availability: 'all', disabled: 'active', hidden: 'active' } },
  { id: 'closed', name: '已禁用', patch: { access: 'all', availability: 'all', disabled: 'only', hidden: 'active' } },
  // 已隐藏页要能找回任何被隐藏的模型（含被禁用的），故其余维度全放开。
  { id: 'concealed', name: '已隐藏', patch: { access: 'all', availability: 'all', disabled: 'all', hidden: 'only' } },
] as const
const initialFilters = { search: '', channel: 'all', capability: 'all', availability: 'available', access: 'all', disabled: 'active', hidden: 'active' }
type Operation = 'refresh' | 'probe' | 'test' | 'export'
type TestState = { model: Model; state: 'pending' | 'success' | 'error' | 'cancelled'; result?: ModelTestResult; error?: string }

/**
 * 「探测可用性」进度条。POST /models/refresh 要等整轮跑完才返回，前端只能靠
 * 轮询 /models/probe 拿快照，这里把它画出来。
 * catalog 阶段还没拿到渠道行总数，用不确定态条纹；channels 阶段按已完成条数填充。
 */
function ProbeBar({ progress }: { progress: ProbeProgress }) {
  const determinate = progress.phase === 'channels' && progress.total > 0
  const percent = determinate ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0
  // finishedAt 为 0 表示还在跑；轮询每 600ms 带来新对象，累计秒数随之更新。
  const end = progress.finishedAt > 0 ? progress.finishedAt : Date.now()
  const elapsed = progress.startedAt > 0 ? Math.max(0, Math.round((end - progress.startedAt) / 1000)) : 0
  const label = determinate ? `正在探测可用性 ${progress.done} / ${progress.total}` : '正在刷新模型清单…'
  return <div className="probe-progress" data-testid="probe-progress" role="status">
    <div className="probe-progress-head">
      <LoaderCircle size={14} className="spinning" />
      <span>{label}</span>
      <span className="probe-progress-elapsed">已用 {elapsed}s</span>
    </div>
    <div className={`probe-progress-track${determinate ? '' : ' is-indeterminate'}`} role="progressbar"
      aria-label="探测进度" aria-valuemin={0} aria-valuemax={determinate ? progress.total : undefined}
      aria-valuenow={determinate ? progress.done : undefined}>
      <div className="probe-progress-fill" style={determinate ? { width: `${percent}%` } : undefined} />
    </div>
  </div>
}

export function Models({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const visibility = visibilityCopy(document.documentElement.lang)
  const [filters, setFilters] = useState(initialFilters)
  const [operation, setOperation] = useState<Operation>()
  // 探测进行中的进度快照：只在 operation === 'probe' 期间有值。
  const [progress, setProgress] = useState<ProbeProgress>()
  const [test, setTest] = useState<TestState>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string>()
  const [toggling, setToggling] = useState<string>()
  const [exportingId, setExportingId] = useState<string>()
  // 行内 ⋯ 菜单单例互斥：同一时刻只展开一行的更多菜单。
  const [openMenuId, setOpenMenuId] = useState<string>()
  const [focusedId, setFocusedId] = useState<string>()
  // 上游 v2.5.2 的「隐藏模型」体系（与本地「禁用」体系并存）：批量整组隐藏
  // （免费/EAC）与单模型隐藏都走 saveSettings 局部补丁，用 visibilityPending
  // 串行化，避免连续点击时后发请求覆盖先发。
  const [visibilitySaving, setVisibilitySaving] = useState(false)
  const visibilityPending = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pending = useRef<AbortController | undefined>(undefined)
  // 探测进度的轮询停止函数；切走页面/操作结束时必须调用，否则计时器会跟着组件泄漏。
  const probePoll = useRef<(() => void) | undefined>(undefined)
  const activeRef = useRef(active)
  activeRef.current = active
  const models = useMemo<Model[]>(() => filterModels(summary.catalog, filters), [summary.catalog, filters])
  const channels = useMemo(() => [...new Set(['anonymous', 'kilo', 'eac', ...summary.catalog.map(model => model.channel), filters.channel])]
    .filter(id => id !== 'all'), [summary.catalog, filters.channel])
  const focusedIndex = focusedId ? models.findIndex(model => model.id === focusedId) : -1
  const rangeExtractor = useCallback((range: Range) => {
    const visible = defaultRangeExtractor(range)
    return focusedIndex >= 0 ? [...new Set([...visible, focusedIndex])].sort((a, b) => a - b) : visible
  }, [focusedIndex])
  const virtual = useVirtualizer({
    count: models.length, getScrollElement: () => scrollRef.current,
    estimateSize: () => 112, overscan: 5, enabled: active,
    getItemKey: index => models[index].id, rangeExtractor,
  })
  const changeFilters = (patch: Partial<typeof initialFilters>) => {
    // 使用原生滚动归零，避免动态测量时平滑滚动的目标高度变化。
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setFilters(previous => ({ ...previous, ...patch }))
    setFocusedId(undefined)
  }
  useEffect(() => {
    if (!active) {
      pending.current?.abort()
      pending.current = undefined
      probePoll.current?.()
      probePoll.current = undefined
      setProgress(undefined)
      setOperation(undefined)
      setExportingId(undefined)
      setOpenMenuId(undefined)
      setTest(previous => previous?.state === 'pending' ? { ...previous, state: 'cancelled' } : previous)
    }
    return () => { pending.current?.abort(); pending.current = undefined; probePoll.current?.(); probePoll.current = undefined }
  }, [active])
  useEffect(() => {
    if (active && scrollRef.current) {
      const max = Math.max(0, virtual.getTotalSize() - scrollRef.current.clientHeight)
      if (scrollRef.current.scrollTop > max) scrollRef.current.scrollTop = max
    }
  }, [models.length, active, virtual])

  // 探测期间每 600ms 拉一次进度快照。轮询本身失败不打扰用户——主请求会用真实
  // 原因报错；服务端说 running=false 就停，避免主请求返回后还在空转。
  const startProbeProgress = () => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => { alive = false; if (timer !== undefined) clearInterval(timer); timer = undefined }
    const tick = () => {
      void host.probeProgress().then(next => {
        if (!alive || !activeRef.current) return
        setProgress(next)
        if (!next.running) stop()
      }).catch(() => {})
    }
    timer = setInterval(tick, 600)
    tick()
    return stop
  }

  const run = async (kind: Operation, model?: Model) => {
    if (pending.current || !activeRef.current) return
    const controller = new AbortController()
    pending.current = controller
    setOperation(kind); setError(''); setMessage('')
    if (kind === 'probe') { setProgress(undefined); probePoll.current = startProbeProgress() }
    if (model) setTest({ model, state: 'pending' })
    const isCurrent = () => pending.current === controller && !controller.signal.aborted && activeRef.current
    try {
      if (kind === 'test' && model) {
        const result = await host.testModel(model.id, controller.signal)
        if (!isCurrent()) return
        setTest({ model, state: 'success', result })
        try {
          await host.refresh()
        } catch (reason) {
          if (!isCurrent()) return
          const detail = reason instanceof Error ? reason.name === 'TimeoutError' ? '请求超时，请重试。' : reason.message : '请求失败，请重试。'
          setError(`模型测试已成功，但刷新摘要失败：${detail}`)
        }
      } else {
        await host.refreshModels(kind === 'probe', controller.signal)
        if (!isCurrent()) return
        setMessage(kind === 'probe' ? '可用性探测已完成' : '模型清单已更新')
      }
    } catch (reason) {
      if (!isCurrent()) return
      const detail = reason instanceof Error ? reason.name === 'TimeoutError' ? '请求超时，请重试。' : reason.message : '操作失败，请重试。'
      if (kind === 'test' && model) setTest({ model, state: 'error', error: detail })
      else setError(detail)
    } finally {
      if (isCurrent()) {
        pending.current = undefined
        setOperation(undefined)
        // 主请求已返回，进度条的轮询必须同时停掉，否则会一直打 /models/probe。
        probePoll.current?.()
        probePoll.current = undefined
        setProgress(undefined)
      }
    }
  }

  const cancel = () => {
    pending.current?.abort()
    pending.current = undefined
    setOperation(undefined)
    setTest(previous => previous ? { ...previous, state: 'cancelled' } : previous)
  }

  const copyModelId = (model: Model) => {
    void host.copy(model.id).then(() => {
      if (activeRef.current) {
        setCopied(model.id)
        setTimeout(() => { if (activeRef.current) setCopied(undefined) }, 1800)
      }
    }).catch(host.error)
  }

  const toggleModel = (model: Model) => {
    if (toggling) return
    setToggling(model.id)
    void host.setModelDisabled(model.id, model.disabled !== true)
      .then(() => { if (activeRef.current) setMessage(model.disabled ? `已启用 ${model.name}` : `已禁用 ${model.name}，可在「已禁用」页重新启用`) })
      .catch(host.error)
      .finally(() => { if (activeRef.current) setToggling(undefined) })
  }

  // 上游「隐藏模型」写入通道：局部 patch 交给 saveSettings（app.tsx 已改为
  // 乐观更新 snapshot，故隐藏即时反映到整表），保存后刷新摘要确认落盘。
  const saveVisibility = async (patch: Partial<ServiceSettings>) => {
    if (visibilityPending.current || !activeRef.current) return
    visibilityPending.current = true
    setVisibilitySaving(true); setError(''); setMessage('')
    try {
      await host.saveSettings(patch)
      if (activeRef.current) setMessage(visibility.saved)
      try { await host.refresh() } catch (reason) { if (activeRef.current) host.error(reason as Error) }
    } catch (reason) {
      if (activeRef.current) setError(reason instanceof Error ? reason.message : '保存失败，请重试。')
    } finally {
      visibilityPending.current = false
      setVisibilitySaving(false)
    }
  }

  // 写入 WorkBuddy / WorkBuddy AI 国际版：幂等单模型 upsert，无二次确认；与 toggleModel 相同的卸载保护。
  // exportingId 记录「模型 ID + 目标」，让两个写入项的 loading 文案互不串扰。
  const exportModel = (model: Model, target?: 'ai') => {
    if (operation || exportingId !== undefined) return
    const slot = target ? `${model.id}:ai` : model.id
    setOperation('export'); setExportingId(slot); setError(''); setMessage('')
    void host.writeModelToWorkbuddy(model.id, resolveEndpointBase(summary.baseUrl), target)
      .then(result => {
        if (activeRef.current) {
          const label = target ? 'WorkBuddy AI 国际版' : 'WorkBuddy'
          setMessage(`已写入 ${label}：${model.name}（${result.updated > 0 ? '已更新' : '首次新增'}），重启 ${label} 后生效`)
        }
      })
      .catch(reason => {
        if (!activeRef.current) return
        setError(reason instanceof Error ? (reason.name === 'TimeoutError' ? '请求超时，请重试。' : reason.message) : '操作失败，请重试。')
      })
      .finally(() => { if (activeRef.current) { setOperation(undefined); setExportingId(undefined) } })
  }

  if (!active) return null
  const filtered = Object.entries(filters).some(([key, value]) => value !== initialFilters[key as keyof typeof initialFilters])
  const routable = summary.catalog.filter(model => model.routable && !model.disabled).length
  const closed = summary.catalog.filter(model => model.disabled).length
  const concealed = summary.catalog.filter(model => model.hiddenByUser === true).length
  return <div className="model-browser" data-testid="models-ready">
    <header className="dashboard-heading">
      <div><div className="heading-eyebrow">WORKSPACE / MODELS</div><h1>模型清单</h1>
        <p>{number(summary.catalog.length)} 个模型 · {number(routable)} 个可接入{closed > 0 && ` · ${number(closed)} 个已禁用`}</p></div>
      <div className="actions">
        <Button variant="outline" disabled={!!operation} onClick={() => { void run('refresh') }}>
          <RefreshCw size={15} className={operation === 'refresh' ? 'spinning' : ''} />{operation === 'refresh' ? '正在刷新' : '刷新清单'}
        </Button>
        <Button disabled={!!operation || !summary.settings.enabled} title="会向上游发送少量推理请求"
          onClick={() => { void run('probe') }}>
          {operation === 'probe' ? <LoaderCircle size={15} className="spinning" /> : <CircleCheck size={15} />}
          {operation === 'probe' ? '正在探测' : '探测可用性'}
        </Button>
      </div>
    </header>
    {operation === 'probe' ? <ProbeBar progress={progress ?? { running: true, phase: 'catalog', done: 0, total: 0, startedAt: Date.now(), finishedAt: 0 }} /> : null}
    <EndpointStrip host={host} summary={summary} />
    <div className="model-summary">
      <span><span className={`status-dot ${summary.settings.enabled ? '' : 'paused'}`} />{summary.settings.enabled ? '推理已启用' : '推理已暂停'}</span>
      <span>清单更新：{summary.catalogSyncedAt ? new Date(summary.catalogSyncedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未刷新'}</span>
      <span>主动探测和测试会产生推理请求</span>
    </div>
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span>
      <Button variant="ghost" aria-label="关闭错误提示" title="关闭错误提示" onClick={() => setError('')}><X size={15} /></Button></div>}
    {message && <p className="model-feedback" role="status"><Check size={15} />{message}</p>}
    <div className="model-filters">
      <div className="model-search"><Search size={16} /><Input type="search" aria-label="搜索模型" placeholder="搜索模型名称或 ID…"
        value={filters.search} onChange={event => changeFilters({ search: event.target.value })} /></div>
      <select aria-label="筛选渠道" value={filters.channel} onChange={event => changeFilters({ channel: event.target.value })}>
        <option value="all">全部渠道</option>{channels.map(id => <option value={id} key={id}>{channelName(id)}</option>)}
      </select>
      <select aria-label="筛选模型能力" value={filters.capability} onChange={event => changeFilters({ capability: event.target.value })}>
        <option value="all">全部能力</option><option value="text">纯文本</option><option value="vision">支持视觉</option><option value="reasoning">支持思考</option>
      </select>
      <select aria-label="筛选可用状态" value={filters.availability} onChange={event => changeFilters({ availability: event.target.value })}>
        <option value="all">全部状态</option>{Object.entries(availabilityNames).map(([id, name]) => <option value={id} key={id}>{name}</option>)}
      </select>
    </div>
    <div className="model-list-toolbar">
      <div className="channel-filters" role="group" aria-label="筛选模型视图">
        {views.map(view => {
          const count = view.id === 'closed' ? closed : view.id === 'concealed' ? concealed : 0
          const pressed = filters.access === view.patch.access && filters.availability === view.patch.availability
            && filters.disabled === view.patch.disabled && filters.hidden === view.patch.hidden
          return (
            <button key={view.id} aria-pressed={pressed}
              onClick={() => changeFilters(view.patch)}>{view.name}{count > 0 ? ` ${count}` : ''}</button>
          )
        })}
      </div>
      <div className="model-list-tail">
        {/* 上游 v2.5.2 的整组隐藏开关：与本地禁用体系互不影响，只决定清单默认展示哪些模型。 */}
        <label className="model-visibility-toggle" title={visibility.hideFree}><input type="checkbox" role="switch" checked={summary.settings.hideFreeModels === true}
          disabled={visibilitySaving} onChange={event => { void saveVisibility({ hideFreeModels: event.target.checked }) }} />{visibility.shortFree}</label>
        <label className="model-visibility-toggle" title={visibility.hideEac}><input type="checkbox" role="switch" checked={summary.settings.hideEacModels === true}
          disabled={visibilitySaving} onChange={event => { void saveVisibility({ hideEacModels: event.target.checked }) }} />{visibility.shortEac}</label>
        <span role="status" data-testid="model-result-count">{number(models.length)} / {number(summary.catalog.length)}<span className="count-unit"> 个模型</span></span>
        {filtered && <Button variant="ghost" title="清空筛选" aria-label="清空筛选" onClick={() => changeFilters(initialFilters)}><X size={14} /><span className="clear-label">清空筛选</span></Button>}
      </div>
    </div>
    {test && <section className={`model-test-result model-test-${test.state}`} aria-label="模型测试结果" aria-live="polite">
      <div className="model-test-heading"><div><strong>
        {test.state === 'pending' ? '正在测试' : test.state === 'success' ? '测试完成' : test.state === 'cancelled' ? '测试已取消' : '测试失败'}
      </strong><span>{test.model.name}{test.result && ` · ${number(test.result.latencyMs)} ms`}</span></div>
        {test.state === 'pending' ? <Button variant="outline" onClick={cancel}><Square size={14} />取消测试</Button>
          : <Button variant="ghost" aria-label="关闭测试结果" title="关闭测试结果" onClick={() => setTest(undefined)}><X size={15} /></Button>}
      </div>
      {test.state === 'success' && <><pre>{test.result?.text}</pre>{test.result?.persisted === false && <p role="status">测试已成功，但结果未能保存；请检查数据目录权限或重新测试。</p>}</>}
      {test.state === 'error' && <p>{test.error}</p>}
    </section>}
    {models.length ? <div className="model-table" role="table" aria-label="模型清单" aria-rowcount={models.length + 1} aria-colcount={5}>
      <div className="model-table-header" role="row"><span role="columnheader">模型 / ID</span><span role="columnheader">渠道与能力</span>
        <span role="columnheader">上下文 / 输出</span><span role="columnheader">可用状态</span><span role="columnheader">操作</span></div>
      <div ref={scrollRef} className="model-scroll" role="rowgroup" tabIndex={0} aria-label="滚动模型列表" onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          virtual.scrollToIndex(event.key === 'Home' ? 0 : models.length - 1, { align: event.key === 'Home' ? 'start' : 'end' })
        }
      }}>
        <div className="model-virtual-content" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map(item => {
            const model = models[item.index]
            const state = model.availabilitySource === 'listing' ? 'listed' : model.availability ?? 'unknown'
            const manual = model.availabilitySource === 'manual'
            const failed = manual && state === 'unknown'
            const availabilityName = failed ? '实测失败' : manual && state === 'available' ? '实测可用' : availabilityNames[state] ?? '未知状态'
            const disabledReason = model.disabled ? '模型已禁用，可在「已禁用」页重新启用' : !summary.settings.enabled ? '推理服务已暂停' : !model.routable && !model.hiddenByUser ? '模型尚未公开，请检查渠道账号或模型设置' : operation ? '请等待当前操作完成' : ''
            const canHide = ['anonymous', 'kilo', 'eac', 'aggregate', 'combo'].includes(model.channel)
            return <div role="row" aria-rowindex={item.index + 2} key={item.key} data-index={item.index} data-model-id={model.id}
              className="model-table-row" ref={virtual.measureElement} style={{ transform: `translateY(${item.start}px)` }}
              onFocusCapture={() => setFocusedId(model.id)} onBlurCapture={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(undefined)
              }}>
              <div role="cell" className="model-identity"><strong>{model.name}</strong><code>{model.id}</code></div>
              <div role="cell" className="model-source"><span>{channelName(model.channel)}</span><div className="model-capabilities">
                <Badge>{model.vision ? '视觉' : '纯文本'}</Badge>{model.reasoning && <Badge tone="blue">思考</Badge>}</div></div>
              <div role="cell" className="model-limits"><span title={model.contextWindow ? `${model.contextWindow} Token` : undefined}>{capacity(model.contextWindow)} <small>上下文</small></span>
                <span title={model.maxOutput ? `${model.maxOutput} Token` : undefined}>{capacity(model.maxOutput)} <small>输出</small></span></div>
              <div role="cell" className="model-state" title={model.availabilityDetail ?? model.detail ?? undefined}><Badge tone={state === 'available' ? 'success' : failed || warningStates.includes(state) ? 'warning' : 'neutral'}>
                {model.disabled ? '已禁用' : availabilityName}</Badge>{!model.routable && !model.disabled && <small>{model.hiddenByUser ? visibility.hidden : '未公开'}</small>}
                {model.ttftMs != null && <small>首响应 {number(model.ttftMs)} ms</small>}
                {/* 判定原文：徽章只放得下状态名，失败原因（限流何时解禁 / 需重新登录 /
                    探测超时）在这里露出；只要状态不是「已探测可用」且确实带了原因就显示，
                    因为用户点开「未探测」视图最想知道的正是它为什么还没通过。
                    手工实测（availabilitySource=manual）读 detail，自动探测读 availabilityDetail。
                    CSS 截断两行，完整内容挂在单元格的 title 上。 */}
                {!model.disabled && state !== 'available' && (model.availabilityDetail || model.detail)
                  ? <small className="model-state-detail">{model.availabilityDetail || model.detail}</small> : null}</div>
              {/* 规则 3：行内 ≤2 钮 + ⋯ 菜单。复制=图标钮，禁用/启用与测试=主操作，
                  低频的隐藏与写入收进 ⋯ 菜单（隐藏=上游体系，写入=本地导出）。 */}
              <div role="cell" className="model-row-actions">
                <Button variant="ghost" title={`复制 ${model.id}`} aria-label={`复制模型 ID：${model.id}`} onClick={() => copyModelId(model)}
                  className={copied === model.id ? 'md-copy-done' : ''}>
                  {copied === model.id ? <Check size={16} /> : <Copy size={16} />}
                </Button>
                <Button variant="outline" disabled={!!toggling && toggling !== model.id}
                  title={model.disabled ? `重新启用 ${model.name}` : `禁用 ${model.name}，禁用后从清单默认视图隐藏`}
                  aria-label={`${model.disabled ? '启用' : '禁用'}模型：${model.id}`} onClick={() => toggleModel(model)}
                  className={toggling === model.id ? 'md-testing' : ''}>
                  {toggling === model.id ? <LoaderCircle size={14} className="spinning" /> : <Power size={14} />}{model.disabled ? '启用' : '禁用'}
                </Button>
                <Button disabled={!!disabledReason} title={disabledReason || `测试 ${model.name}，会产生推理请求`}
                  aria-label={`测试模型：${model.id}`} onClick={() => { void run('test', model) }}
                  className={operation === 'test' && test?.model.id === model.id ? 'md-testing' : ''}>
                  {operation === 'test' && test?.model.id === model.id ? <LoaderCircle size={14} className="spinning" /> : <Play size={14} />}测试
                </Button>
                {/* combo 行没有真实模型可写入 WorkBuddy（必 404），菜单只剩「隐藏」；
                    既无隐藏资格又非可写入渠道时整个菜单不渲染。 */}
                {(canHide || model.channel !== 'combo') && <DropdownMenu triggerLabel={`更多操作：${model.name}`} icon={<MoreHorizontal size={15} />}
                  triggerClassName="md-more" open={openMenuId === model.id}
                  onOpenChange={next => setOpenMenuId(next ? model.id : undefined)}
                  items={[
                    ...(canHide ? [{
                      key: 'visibility',
                      label: model.hiddenByUser ? visibility.show : visibility.hide,
                      icon: model.hiddenByUser ? <Eye size={14} /> : <EyeOff size={14} />,
                      disabled: visibilitySaving || model.hiddenByGroup === true,
                      title: model.hiddenByGroup ? visibility.groupHidden : model.hiddenByUser ? visibility.show : visibility.hide,
                      onSelect: () => { void saveVisibility({
                        hiddenModelIds: nextHiddenIds(summary.settings.hiddenModelIds, model.id),
                      }) },
                    }] : []),
                    ...(model.channel !== 'combo' ? [
                      {
                        key: 'export',
                        label: operation === 'export' && exportingId === model.id ? '写入中…' : '写入 WorkBuddy',
                        icon: operation === 'export' && exportingId === model.id ? <LoaderCircle size={14} className="spinning" /> : <Upload size={14} />,
                        disabled: !!disabledReason || !!operation,
                        title: disabledReason || `把 ${model.name} 写入 WorkBuddy 配置（~/.workbuddy）`,
                        onSelect: () => exportModel(model),
                      },
                      {
                        key: 'export-ai',
                        label: operation === 'export' && exportingId === `${model.id}:ai` ? '写入中…' : '写入 WorkBuddy AI 国际版',
                        icon: operation === 'export' && exportingId === `${model.id}:ai` ? <LoaderCircle size={14} className="spinning" /> : <Upload size={14} />,
                        disabled: !!disabledReason || !!operation,
                        title: disabledReason || `把 ${model.name} 写入 WorkBuddy AI 国际版配置（~/.workbuddy-ai）`,
                        onSelect: () => exportModel(model, 'ai'),
                      },
                    ] : []),
                  ]} />}
              </div>
            </div>
          })}
        </div>
      </div>
    </div> : <div className="model-empty"><Boxes size={28} /><h2>{summary.catalog.length ? '没有匹配的模型' : '模型清单为空'}</h2>
      <p>{summary.catalog.length ? '调整搜索条件或清空筛选。' : '刷新清单后重试，或检查渠道连接。'}</p>
      {filtered && <Button variant="outline" onClick={() => changeFilters(initialFilters)}><SlidersHorizontal size={15} />清空筛选</Button>}
    </div>}
    <p className="footnote">清单收录不代表实时可用。Kilo 免费池可能记录提示词，请勿发送敏感内容。</p>
  </div>
}
