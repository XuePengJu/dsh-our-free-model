import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { shared } from 'ofm-shared-client'
import { Button } from './ui'
import type { Summary } from '../types'

interface Status { closed?: boolean; accounts?: { total: number; enabled: number }; models?: { total: number; disabled: number } }
type Rpc = (method: string, payload?: object) => Promise<any>
const t = Object.assign((key: string) => shared.DICT.zh[key] ?? key, { locale: 'zh' })

/**
 * 账号池：本分支只剩一个渠道（WorkBuddy 国际版），
 * 原来「左 340px 列表 + 搜索 + 全部/已接入/待接入 chips + 地区/积分方式筛选」
 * 整套都失去了意义（恒为一条结果、计数恒为 1/0/1），故整体移除，
 * 把原「选中态详情」铺成页面主体。
 *
 * 页头由本组件渲染而不是 `channels.mjs`：「启用渠道」开关要读 `provider.status`，
 * 状态在这里轮询，页头搬出去就得把状态再提升一层。`onOpenTools` 用于打开
 * 「供应商与备份」子页（子页路由仍在 `channels.mjs`）。
 */
export function ChannelBrowser({ rpc, summary, onOpenTools }: {
  rpc: Rpc
  summary: Summary & { reload?(): void }
  onOpenTools(): void
}) {
  const provider = providers[0]
  const providerId = provider?.id
  const [status, setStatus] = useState<Status>()
  const [error, setError] = useState('')
  const [enabling, setEnabling] = useState(false)
  const mounted = useRef(false)
  const sequence = useRef(0)
  const reload = useCallback(async () => {
    if (!providerId) return
    const started = ++sequence.current
    try {
      const value = await rpc('provider.status', { providers: [providerId] })
      if (!mounted.current || started !== sequence.current) return
      setStatus(value.statuses?.[providerId])
      setError('')
    } catch (failure) {
      if (mounted.current && started === sequence.current) setError((failure as Error).message)
    }
  }, [rpc, providerId])
  useEffect(() => {
    mounted.current = true
    void reload()
    // 渠道状态（启用/账号数/模型数）由账号卡上的操作间接改变，45 秒兜底轮询一次。
    const timer = setInterval(() => { void reload() }, 45000)
    return () => { mounted.current = false; sequence.current++; clearInterval(timer) }
  }, [reload])
  const onChanged = useCallback(() => {
    void reload()
    window.dispatchEvent(new CustomEvent('ofm:channels'))
    summary.reload?.()
  }, [reload, summary.reload])
  const onError = useCallback((_provider: unknown, failure: Error) => { if (mounted.current) setError(failure.message) }, [])
  // 页头「启用渠道」开关：显式传目标值（`closed === true` 表示当前已禁用，点它即启用），
  // 不写 `!closed` —— 那会拿渲染时的旧值翻转，连点两次可能发出相同值。
  const toggle = () => {
    if (!provider || enabling) return
    setEnabling(true)
    void rpc('provider.setEnabled', { provider: provider.id, enabled: status?.closed === true })
      .then(() => { if (mounted.current) onChanged() })
      .catch(failure => { if (mounted.current) setError((failure as Error).message) })
      .finally(() => { if (mounted.current) setEnabling(false) })
  }
  if (!provider) return null
  const enabled = status?.closed !== true
  return <>
    <header className="dashboard-heading channels-heading">
      <div>
        <div className="heading-eyebrow">WORKSPACE / CHANNELS</div>
        <h1>{provider.name}</h1>
        <p>{provider.org}</p>
      </div>
      <div className="channels-tools" role="group" aria-label="渠道操作">
        <label className="provider-enable-toggle">
          <span>启用渠道</span>
          <button type="button" role="switch" aria-label={`启用或禁用渠道：${provider.name}`}
            aria-checked={enabled} disabled={!status || enabling}
            className={`ui-switch ${enabled ? 'on' : ''}`} onClick={toggle}><span /></button>
        </label>
        <Button variant="outline" onClick={onOpenTools}><SlidersHorizontal size={14} />供应商与备份</Button>
      </div>
    </header>
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span>
      <Button variant="ghost" onClick={() => { void reload() }}>重试</Button></div>}
    <div className="channel-single" data-testid="provider-detail">
      <shared.ChannelCard channel={provider} status={status} rpc={rpc} t={t} onChanged={onChanged} onError={onError} />
      <div className="detail-security-note">
        <ShieldCheck size={16} />
        <span>沿用原渠道的登录、续期与额度规则。账号备份和供应商设置位于「供应商与备份」。账号凭据保存在本机独立目录。</span>
      </div>
    </div>
  </>
}
