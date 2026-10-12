// 页头正下方的「接入信息条」：左段直接展示完整 API 地址（可见）+ 复制图标，
// 竖线分隔，右段展示打码 API Key（ofm-****）+ 复制图标。
// Key 明文只在点击瞬间经 host.getApiKey() 取出并写入剪贴板，经局部变量传递，
// 永不进 state/render，界面上常驻的只有打码占位。
// 两段各自独立的 copied 反馈（判别联合互不串扰，2 秒还原），供模型清单页与模型组页复用。
import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { resolveEndpointBase } from '../endpoint-origin'
import type { Host, Summary } from '../types'

export interface EndpointStripProps {
  host: Host
  summary: Summary
  className?: string
}

export function EndpointStrip({ host, summary, className = '' }: EndpointStripProps) {
  const url = `${resolveEndpointBase(summary.baseUrl)}/v1`
  // 判别联合：记录哪一段刚复制成功，2 秒后还原；undefined 表示无反馈。
  const [copied, setCopied] = useState<'url' | 'key'>()
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 卸载时清理定时器，避免严格模式下重复挂载导致的竞态还原。
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const flash = (which: 'url' | 'key') => {
    setCopied(which)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(undefined), 2000)
  }

  const copyUrl = () => {
    void host.copy(url).then(() => flash('url')).catch(host.error)
  }

  const copyKey = () => {
    // Key 明文只经局部变量流动：取到即写入剪贴板，失败则仅提示先登录管理台，不复制。
    void host.getApiKey().then(key => host.copy(key)).then(() => flash('key'))
      .catch(() => host.error(new Error('API Key 获取失败，请先登录管理台')))
  }

  return <div className={['ep-strip', className].filter(Boolean).join(' ')} role="group" aria-label="接入信息">
    <span className="ep-strip-tag">API</span>
    <div className="ep-strip-seg ep-strip-url">
      <code title={url}>{url}</code>
      <button type="button" className={`ep-strip-copy${copied === 'url' ? ' is-copied' : ''}`}
        aria-label="复制 API 地址" title="复制 API 地址" onClick={copyUrl}>
        {copied === 'url' ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
    <div className="ep-strip-divider" aria-hidden="true"></div>
    <div className="ep-strip-seg ep-strip-key">
      <code>ofm-****</code>
      <button type="button" className={`ep-strip-copy${copied === 'key' ? ' is-copied' : ''}`}
        aria-label="复制 API Key" title="复制 API Key" onClick={copyKey}>
        {copied === 'key' ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  </div>
}
