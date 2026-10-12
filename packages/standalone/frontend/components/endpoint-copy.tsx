// 页头「复制地址 / 复制密钥」成组按钮：分项复制接入信息，取代旧的整段 JSON 复制。
// Key 只在点击瞬间经 host.getApiKey() 取出并写入剪贴板，永不明文常驻界面。
// 两个按钮各自独立的 copied 反馈（2 秒还原），供模型清单页与模型组页头部复用。
import { useEffect, useRef, useState } from 'react'
import { Check, KeyRound, Link2 } from 'lucide-react'
import { Button } from './ui'
import { resolveEndpointBase } from '../endpoint-origin'
import type { Host, Summary } from '../types'

export interface EndpointCopyButtonsProps {
  host: Host
  summary: Summary
  className?: string
}

export function EndpointCopyButtons({ host, summary, className = '' }: EndpointCopyButtonsProps) {
  // 判别联合：记录哪个按钮刚复制成功，2 秒后还原。
  const [copied, setCopied] = useState<'url' | 'key'>()
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const flash = (which: 'url' | 'key') => {
    setCopied(which)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(undefined), 2000)
  }

  const copyUrl = () => {
    void host.copy(`${resolveEndpointBase(summary.baseUrl)}/v1`)
      .then(() => flash('url')).catch(host.error)
  }

  const copyKey = () => {
    // Key 获取失败或复制失败都不落盘，仅提示先登录管理台。
    void host.getApiKey().then(key => host.copy(key)).then(() => flash('key'))
      .catch(() => host.error(new Error('API Key 获取失败，请先登录管理台')))
  }

  return <div className={['ep-copy', className].filter(Boolean).join(' ')} role="group" aria-label="复制接入信息">
    <Button variant="outline" size="sm" aria-label="复制 API 地址" title="复制 API 地址"
      onClick={copyUrl} className={copied === 'url' ? 'ep-copy-copied' : ''}>
      {copied === 'url' ? <Check size={14} /> : <Link2 size={14} />}{copied === 'url' ? '已复制' : '复制地址'}
    </Button>
    <Button variant="outline" size="sm" aria-label="复制 API Key" title="复制 API Key"
      onClick={copyKey} className={copied === 'key' ? 'ep-copy-copied' : ''}>
      {copied === 'key' ? <Check size={14} /> : <KeyRound size={14} />}{copied === 'key' ? '已复制' : '复制密钥'}
    </Button>
  </div>
}
