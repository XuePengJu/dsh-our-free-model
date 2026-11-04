import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { shared } from 'ofm-shared-client'
import { ChannelBrowser } from './components/channel-browser'
import { ConfirmDialog } from './components/ui'
import 'ofm-shared-styles.css'

const { DICT, CHANNEL_PROVIDERS, LogsPage } = shared
const h = React.createElement
const t = key => DICT.zh[key] ?? key
t.locale = 'zh'
// rpc 上下文工厂：每个挂载实例一份独立 AbortController 生命周期——
// 请求日志页（LogsMount）与渠道页互不牵连（渠道页 hide() 只 abort 自己的）。
function makeRpcContext() {
  const state = { lifetime: new AbortController() }
  const call = async (_base, _method, payload, signal) => {
    const response = await fetch('/api/management/channels/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.any([signal, state.lifetime.signal]), credentials: 'same-origin',
    })
    const result = await response.json()
    state.lifetime.signal.throwIfAborted()
    if (response.status === 401) window.dispatchEvent(new CustomEvent('ofm:unauthorized'))
    if (!response.ok) throw new Error(result.error ?? '渠道请求失败')
    return result
  }
  return { state, connection: { rpc: { call } } }
}
const ctx = makeRpcContext()
async function rpc(method, payload = {}) {
  const result = await ctx.connection.rpc.call('/api', 'channel-pack', { method, payload }, AbortSignal.timeout(180000))
  if (!result.ok) throw new Error(result.error?.message ?? '渠道操作失败')
  return result.value
}
const lockedProviders = new Set(CHANNEL_PROVIDERS.map(row => row.id))

function ChannelTools({ summary }) {
  const [provider, setProvider] = React.useState(CHANNEL_PROVIDERS[0]?.id ?? 'workbuddy')
  const [status, setStatus] = React.useState()
  const [lock, setLock] = React.useState()
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [accounts, setAccounts] = React.useState([])
  const [account, setAccount] = React.useState('')
  const [nickname, setNickname] = React.useState('')
  const file = React.useRef()
  const generation = React.useRef(0)
  const reload = React.useCallback(async () => {
    const started = ++generation.current
    const [statuses, value, nextLock] = await Promise.all([
      rpc('provider.status', { providers: [provider] }),
      rpc('account.list', { provider }),
      lockedProviders.has(provider) ? rpc('credits.permanentLock', { provider }) : undefined,
    ])
    if (started !== generation.current) return
    setStatus(statuses.statuses[provider])
    setAccounts(value.accounts)
    setLock(nextLock)
  }, [provider])
  React.useEffect(() => {
    setStatus(undefined); setLock(undefined); setAccounts([]); setAccount(''); setNickname(''); setMessage('')
    let active = true
    void reload().catch(error => { if (active) setMessage(error.message) })
    return () => { active = false; generation.current++ }
  }, [reload])
  const run = async action => {
    setBusy(true); setMessage('')
    try {
      await action()
      await reload()
      window.dispatchEvent(new CustomEvent('ofm:channels'))
      summary.reload?.()
      setMessage('已保存。')
    } catch (error) { setMessage(error.message) }
    finally { setBusy(false) }
  }
  const backup = async () => {
    const value = await rpc('backup.export')
    const blob = new Blob([JSON.stringify(value.payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = `ofm-channels-${new Date().toISOString().slice(0, 10)}.json`
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
  const [confirmImport, setConfirmImport] = React.useState(null)
  const importFile = async event => {
    const selected = event.target.files[0]
    event.target.value = ''
    if (!selected) return
    if (selected.size > 8 * 1024 * 1024) { setMessage('备份文件不能超过 8MB。'); return }
    // 原生 confirm 换成页内确认弹层：先读出并解析备份内容，坏 JSON 直接提示不弹确认框。
    let payload
    try { payload = JSON.parse(await selected.text()) } catch {
      setMessage('备份文件不是有效的 JSON。')
      return
    }
    setConfirmImport({ payload })
  }
  const runImport = () => {
    const payload = confirmImport?.payload
    setConfirmImport(null)
    if (payload) void run(async () => { await rpc('backup.import', { payload }) })
  }
  return h('section', { className: 'ofm_hero', 'aria-label': '供应商与数据管理' },
    h('div', { className: 'ofm_row' },
      h('label', null, '供应商 ', h('select', { value: provider, disabled: busy, onChange: event => setProvider(event.target.value) },
        CHANNEL_PROVIDERS.map(row => h('option', { value: row.id, key: row.id }, row.name)))),
      h('button', { className: 'ofm_btn', disabled: busy || !status, onClick: () => run(() => rpc('provider.setEnabled', { provider, enabled: status.closed === true })) },
        status?.closed ? '启用供应商' : '禁用供应商'),
      lock ? h('label', null, h('input', { type: 'checkbox', checked: lock.locked === true, disabled: busy, onChange: event => run(() => rpc('credits.permanentLock', { provider, locked: event.target.checked })) }), ' 锁定永久积分') : null),
    lock ? h('p', { className: 'ofm_note' }, lock.windowDays ? `锁定后仅使用 ${lock.windowDays} 天内到期的积分；免费模型沿用原有豁免规则。` : '锁定后按原渠道规则保护永久积分。') : null,
    h('div', { className: 'ofm_row' },
      h('label', null, '账号 ', h('select', { value: account, disabled: busy, onChange: event => { setAccount(event.target.value); setNickname(accounts.find(row => row.id === event.target.value)?.nickname ?? '') } },
        h('option', { value: '' }, '选择账号'),
        accounts.map(row => h('option', { value: row.id, key: row.id }, row.nickname ?? row.id)))),
      h('input', { 'aria-label': '账号昵称', value: nickname, placeholder: '账号昵称', disabled: !account || busy, onChange: event => setNickname(event.target.value) }),
      h('button', { className: 'ofm_btn', disabled: !account || busy, onClick: () => run(() => rpc('account.update', { accountId: account, patch: { nickname } })) }, '保存昵称'),
      h('button', { className: 'ofm_btn', disabled: !account || busy, onClick: () => run(() => rpc('account.reorder', { provider, orderedIds: [account, ...accounts.filter(row => row.id !== account).map(row => row.id)] })) }, '优先使用'),
      h('button', { className: 'ofm_btn', disabled: !account || busy, onClick: () => run(() => rpc('account.reset', { accountId: account })) }, '重置限流标记')),
    h('div', { className: 'ofm_row ofm_acts' },
      h('button', { className: 'ofm_btn', disabled: busy, onClick: () => run(backup) }, '导出账号备份'),
      h('button', { className: 'ofm_btn', disabled: busy, onClick: () => file.current.click() }, '导入账号备份'),
      h('input', { ref: file, type: 'file', hidden: true, accept: '.json,application/json', onChange: importFile })),
    h('p', { className: 'ofm_note' }, '备份包含登录凭据，请保存在可信的本地位置。插件导出的原格式备份也可以手动导入。'),
    message ? h('p', { role: 'status', className: 'ofm_note' }, message) : null,
    h(ConfirmDialog, {
      open: confirmImport !== null, danger: true, title: '导入账号备份',
      body: '导入会合并备份中的账号凭据、模型开关和积分锁定设置，确认继续吗？',
      confirmText: '确认导入', onConfirm: runImport, onCancel: () => setConfirmImport(null),
    }))
}

function ChannelConsole({ summary }) {
  const [page, setPage] = React.useState('accounts')
  // 账号池页头现在由 ChannelBrowser 自己渲染（标题就是渠道名，右侧带「启用渠道」开关），
  // 因为那个开关要读 provider.status，状态本来就在组件里轮询，搬出来得再提升一层。
  if (page === 'accounts') return h(ChannelBrowser, { rpc, summary, onOpenTools: () => setPage('tools') })
  return h(React.Fragment, null,
    h('header', { className: 'dashboard-heading channels-heading' },
      h('div', null, h('div', { className: 'heading-eyebrow' }, 'WORKSPACE / CHANNELS'),
        h('h1', null, '供应商与备份')),
      h('button', { type: 'button', className: 'ui-button ui-button-outline channels-back',
        onClick: () => setPage('accounts') }, '← 返回')),
    h('div', { className: 'channels-subpage' }, h(ChannelTools, { summary })))
}


// 请求日志顶层页：每实例独立 rpc 生命周期，卸载时 abort 在途请求。
export function LogsMount() {
  const own = React.useMemo(makeRpcContext, [])
  React.useEffect(() => () => { own.state.lifetime.abort() }, [own])
  return h(LogsPage, { t, ctx: own })
}

let root
export function show(summary) {
  if (!root) {
    ctx.state.lifetime = new AbortController()
    root = createRoot(document.getElementById('channel-root'))
  }
  root.render(h(ChannelConsole, { t, ctx, summary }))
}
export function hide() {
  ctx.state.lifetime.abort()
  if (root) { root.unmount(); root = undefined }
}
