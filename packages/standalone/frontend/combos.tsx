import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, CircleAlert, CircleCheck, Layers, LoaderCircle, Play, Plus, Search, Trash2, X } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { Badge, Button, Input, Switch } from './components/ui'
import type { Combo, ComboDraft, Host, Model, ModelTestResult, Summary } from './types'
import './combos.css'

const strategyNames: Record<string, string> = { fallback: '顺序降级', 'round-robin': '轮询分流' }
const strategyHints: Record<string, string> = {
  fallback: '始终从第一个模型开始；它没积分、失败或限流时，在输出正文前自动换下一个。',
  'round-robin': '按顺序轮流从不同模型起步，把用量摊到整条链上，适合避免单个渠道被打满。',
}
const sourceNames: Record<string, string> = { anonymous: '匿名模型', kilo: 'Kilo 免费池', eac: 'EAC 协付' }
const channelName = (id: string) => sourceNames[id]
  ?? providers.find(provider => provider.id === id)?.name ?? id
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value)

type Draft = { id?: string; name: string; models: string[]; strategy: string; stickyLimit: number }
const emptyDraft: Draft = { name: '', models: [], strategy: 'fallback', stickyLimit: 3 }
type TestState = { id: string; state: 'pending' | 'success' | 'error' | 'cancelled'; result?: ModelTestResult; error?: string }

export function Combos({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const [combos, setCombos] = useState<Combo[]>()
  const [draft, setDraft] = useState<Draft>()
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [draftError, setDraftError] = useState('')
  const [confirming, setConfirming] = useState<string>()
  const [test, setTest] = useState<TestState>()
  const pending = useRef<AbortController | undefined>(undefined)
  const editorRef = useRef<HTMLElement>(null)
  // 编辑器打开或切换编辑目标时，把它滚进视野——编辑器渲染在页面顶部，
  // 用户停留在下方卡片处点「编辑」时若不滚动，会以为按钮没反应。
  const editorOpenKey = draft === undefined ? null : draft.id ?? '__new__'
  useEffect(() => {
    if (editorOpenKey !== null) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [editorOpenKey])
  const activeRef = useRef(active)
  activeRef.current = active

  const load = async () => {
    try { setCombos(await host.listCombos()); setError('') } catch (reason) {
      if (!activeRef.current) return
      setError(reason instanceof Error ? reason.message : '模型组加载失败，请重试。')
    }
  }
  useEffect(() => { if (active) void load() }, [active])
  useEffect(() => () => { pending.current?.abort(); pending.current = undefined }, [])

  const byId = useMemo(() => new Map(summary.catalog.map(model => [model.id, model])), [summary.catalog])
  // 模型组成员只能是真实模型：排除组合行自身。
  const picker = useMemo(() => {
    const query = search.trim().toLowerCase()
    return summary.catalog.filter(model => model.channel !== 'combo'
      && (query === '' || model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query)))
  }, [summary.catalog, search])

  const run = async (action: () => Promise<string>) => {
    setSaving(true); setError(''); setMessage('')
    try { setMessage(await action()) } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败，请重试。')
    } finally { setSaving(false) }
  }
  const save = () => {
    const name = draft?.name.trim() ?? ''
    if (name === '') { setDraftError('请先给模型组起个名字。'); return }
    if (draft !== undefined && draft.models.length === 0) { setDraftError('请至少勾选一个模型。'); return }
    setDraftError('')
    const payload: ComboDraft = {
      ...(draft?.id !== undefined ? { id: draft.id } : {}),
      name, models: draft?.models ?? [], strategy: draft?.strategy ?? 'fallback',
      ...(draft?.strategy === 'round-robin' ? { stickyLimit: draft.stickyLimit } : {}),
    }
    void run(async () => {
      const rows = await host.saveCombo(payload)
      const created = rows.find(row => row.name === name)
      setCombos(rows); setDraft(undefined)
      return (draft?.id !== undefined ? '模型组已更新' : `模型组已创建：${created?.id ?? `combo:${name}`}`) +
        '。API 侧调用该 ID 即可生效。'
    })
  }
  const remove = (combo: Combo) => {
    if (confirming !== combo.id) { setConfirming(combo.id); return }
    setConfirming(undefined)
    void run(async () => { setCombos(await host.deleteCombo(combo.id)); return `已删除模型组 ${combo.name}` })
  }
  const toggle = (combo: Combo, enabled: boolean) => {
    void run(async () => {
      setCombos(await host.saveCombo({ ...combo, enabled }))
      return enabled ? `已启用 ${combo.name}` : `已停用 ${combo.name}（API 调用将返回 404）`
    })
  }
  const move = (index: number, step: -1 | 1) => {
    setDraft(previous => {
      if (previous === undefined) return previous
      const models = [...previous.models]
      const [id] = models.splice(index, 1)
      models.splice(index + step, 0, id)
      return { ...previous, models }
    })
  }
  const toggleModel = (id: string) => {
    setDraft(previous => {
      if (previous === undefined) return previous
      return previous.models.includes(id)
        ? { ...previous, models: previous.models.filter(value => value !== id) }
        : { ...previous, models: [...previous.models, id] }
    })
  }

  const runTest = (combo: Combo) => {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setTest({ id: combo.id, state: 'pending' })
    host.testModel(combo.id, controller.signal).then(result => {
      if (!activeRef.current) return
      setTest({ id: combo.id, state: 'success', result })
    }).catch(reason => {
      if (!activeRef.current) return
      if (controller.signal.aborted) { setTest(previous => previous?.id === combo.id ? { ...previous, state: 'cancelled' } : previous); return }
      setTest({ id: combo.id, state: 'error', error: reason instanceof Error ? reason.message : '测试失败，请重试。' })
    }).finally(() => { if (pending.current === controller) pending.current = undefined })
  }

  if (!active) return null
  return <div className="combo-browser" data-testid="combos-ready">
    <header className="dashboard-heading">
      <div><div className="heading-eyebrow">WORKSPACE / COMBOS</div><h1>模型组</h1>
        <p>{combos === undefined ? '正在加载…' : `${number(combos.length)} 个模型组 · 对外是一个 combo:名称 虚拟模型`}</p></div>
      <div className="actions">
        <Button disabled={draft !== undefined || saving} onClick={() => { setDraft({ ...emptyDraft }); setDraftError(''); setMessage('') }}>
          <Plus size={15} />新建模型组
        </Button>
      </div>
    </header>
    <div className="model-summary">
      <span><Layers size={14} />把多个模型串成一条调用链：前面的模型没积分、失败或限流时自动换下一个，调用方无感。</span>
      <span>成员按你排的顺序调用，可随时调整。</span>
    </div>
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span>
      <Button variant="ghost" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></Button></div>}
    {message && <p className="model-feedback" role="status"><CircleCheck size={15} />{message}</p>}

    {draft !== undefined && <section ref={editorRef} className="combo-editor" aria-label={draft.id ? '编辑模型组' : '新建模型组'}>
      <div className="combo-editor-head">
        <strong>{draft.id ? '编辑模型组' : '新建模型组'}</strong>
        <Button variant="ghost" aria-label="取消编辑" onClick={() => { setDraft(undefined); setDraftError('') }}><X size={15} /></Button>
      </div>
      <div className="combo-editor-grid">
        <div className="combo-editor-form">
          <label htmlFor="combo-name">模型组名称</label>
          <Input id="combo-name" value={draft.name} maxLength={60} placeholder="例如：deepseek"
            onChange={event => setDraft({ ...draft, name: event.target.value })} />
          <label htmlFor="combo-strategy">调度策略</label>
          <select id="combo-strategy" value={draft.strategy} aria-label="调度策略"
            onChange={event => setDraft({ ...draft, strategy: event.target.value })}>
            <option value="fallback">顺序降级（质量优先）</option>
            <option value="round-robin">轮询分流（摊薄用量）</option>
          </select>
          <p className="combo-hint">{strategyHints[draft.strategy]}</p>
          {draft.strategy === 'round-robin' && <>
            <label htmlFor="combo-sticky">粘滞轮数</label>
            <Input id="combo-sticky" type="number" min={1} max={64} value={draft.stickyLimit}
              onChange={event => setDraft({ ...draft, stickyLimit: Math.min(64, Math.max(1, Number(event.target.value) || 1)) })} />
            <p className="combo-hint">连续多少轮请求固定用同一个模型，再轮到下一个。轮数越大越接近固定使用。</p>
          </>}
        </div>
        <div className="combo-chain">
          <span className="combo-column-label">调用顺序（从上到下）</span>
          {draft.models.length === 0
            ? <p className="combo-hint">还没有成员。从右侧勾选模型加入这条链，先选的排在前面。</p>
            : <ol className="combo-chain-list">{draft.models.map((id, index) => {
              const model = byId.get(id)
              return <li key={id}>
                <span className="combo-order" aria-hidden="true">{index + 1}</span>
                <span className="combo-chain-model"><strong>{model?.name ?? id}</strong><code>{id}</code></span>
                {model !== undefined ? <Badge>{channelName(model.channel)}</Badge> : <Badge tone="warning">暂不可用</Badge>}
                <span className="combo-chain-actions">
                  <Button variant="ghost" size="icon" aria-label={`上移 ${model?.name ?? id}`} disabled={index === 0}
                    onClick={() => move(index, -1)}><ArrowUp size={14} /></Button>
                  <Button variant="ghost" size="icon" aria-label={`下移 ${model?.name ?? id}`} disabled={index === draft.models.length - 1}
                    onClick={() => move(index, 1)}><ArrowDown size={14} /></Button>
                  <Button variant="ghost" size="icon" aria-label={`移除 ${model?.name ?? id}`}
                    onClick={() => toggleModel(id)}><X size={14} /></Button>
                </span>
              </li>
            })}</ol>}
        </div>
        <div className="combo-picker">
          <span className="combo-column-label">可选模型（{number(picker.length)}）</span>
          <div className="model-search"><Search size={16} /><Input type="search" aria-label="搜索模型"
            placeholder="搜索模型名称或 ID…" value={search} onChange={event => setSearch(event.target.value)} /></div>
          <div className="combo-picker-list" role="listbox" aria-label="勾选模型" aria-multiselectable="true">
            {picker.map(model => {
              const picked = draft.models.includes(model.id)
              return <button key={model.id} role="option" aria-selected={picked} className={picked ? 'picked' : ''}
                onClick={() => toggleModel(model.id)}>
                <span className="combo-chain-model"><strong>{model.name}</strong><code>{model.id}</code></span>
                <Badge>{channelName(model.channel)}</Badge>
                {picked && <Check size={14} />}
              </button>
            })}
            {picker.length === 0 && <p className="combo-hint">没有匹配的模型，换个搜索词试试。</p>}
          </div>
        </div>
      </div>
      {draftError && <p className="combo-editor-error" role="alert"><CircleAlert size={14} />{draftError}</p>}
      <div className="combo-editor-actions">
        <Button busy={saving} onClick={save}>{draft.id ? '保存修改' : '创建模型组'}</Button>
        <Button variant="outline" disabled={saving} onClick={() => { setDraft(undefined); setDraftError('') }}>取消</Button>
      </div>
    </section>}

    <div className="combo-list">
      {combos?.map(combo => <article key={combo.id} className={`combo-card${combo.enabled ? '' : ' is-disabled'}`}>
        <div className="combo-card-head">
          <div className="combo-card-title"><strong>{combo.name}</strong><code>{combo.id}</code></div>
          <div className="combo-card-tools">
            <Badge tone="blue">{strategyNames[combo.strategy] ?? combo.strategy}</Badge>
            {combo.strategy === 'round-robin' && <Badge>粘滞 {combo.stickyLimit} 轮</Badge>}
            <Switch checked={combo.enabled} aria-label={`启用或停用 ${combo.name}`}
              onCheckedChange={next => toggle(combo, next)} />
          </div>
        </div>
        <ol className="combo-chain-list">{combo.models.map((id, index) => {
          const model = byId.get(id)
          return <li key={id}>
            <span className="combo-order" aria-hidden="true">{index + 1}</span>
            <span className="combo-chain-model"><strong>{model?.name ?? id}</strong><code>{id}</code></span>
            {model !== undefined ? <Badge>{channelName(model.channel)}</Badge> : <Badge tone="warning">暂不可用</Badge>}
          </li>
        })}</ol>
        <div className="combo-card-actions">
          {test?.id === combo.id && <span className={`combo-test combo-test-${test.state}`} role="status">
            {test.state === 'pending' && <><LoaderCircle size={13} className="spinning" />正在测试…</>}
            {test.state === 'success' && <><CircleCheck size={13} />{number(test.result?.latencyMs ?? 0)} ms</>}
            {test.state === 'error' && <><CircleAlert size={13} />{test.error}</>}
          </span>}
          <Button variant="outline" size="sm" disabled={test?.state === 'pending'} title="用链首可用模型发一次小请求"
            onClick={() => runTest(combo)}>
            {test?.id === combo.id && test.state === 'pending' ? <LoaderCircle size={14} className="spinning" /> : <Play size={14} />}测试
          </Button>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => {
            setDraft({ id: combo.id, name: combo.name, models: [...combo.models], strategy: combo.strategy, stickyLimit: combo.stickyLimit })
            setDraftError(''); setMessage('')
          }}>编辑</Button>
          <Button variant="ghost" size="sm" className={confirming === combo.id ? 'combo-delete-armed' : ''}
            onClick={() => remove(combo)} onBlur={() => setConfirming(previous => previous === combo.id ? undefined : previous)}>
            {confirming === combo.id ? <>确认删除<Trash2 size={14} /></> : <>删除<Trash2 size={14} /></>}
          </Button>
        </div>
      </article>)}
      {combos !== undefined && combos.length === 0 && draft === undefined && <div className="model-empty">
        <Layers size={28} /><h2>还没有模型组</h2>
        <p>把同一类型的多个模型（比如各渠道的 DeepSeek）串成一条链，一个渠道没积分就自动换下一个。</p>
        <Button variant="outline" onClick={() => setDraft({ ...emptyDraft })}><Plus size={15} />新建模型组</Button>
      </div>}
    </div>
    <p className="footnote">链内容量取所有成员的交集（上下文 / 视觉能力）；引用了暂不可用模型的链会保留成员位置，渠道恢复后自动回归。测试会向上游发送少量推理请求。</p>
  </div>
}
