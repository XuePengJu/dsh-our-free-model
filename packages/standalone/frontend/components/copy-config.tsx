// 「复制完整接入配置」按钮：点击瞬间才向 host 取 API Key（Key 永不明文常驻界面），
// 组装 { baseUrl, apiKey?, model } 一次性写入剪贴板。
// 三处入口复用：概览接入卡主按钮（label + default）、模型清单行、模型组标题（纯图标 ghost）。
import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from './ui'
import { buildClientConfig } from '../client-config'
import { resolveEndpointBase } from '../endpoint-origin'
import type { Host, Summary } from '../types'

export interface CopyConfigButtonProps {
  host: Host
  summary: Summary
  /** 模型 ID 或模型组 ID，原样写入 JSON 的 model 字段 */
  model: string
  /** 透传给 ui Button；概览主按钮用 'default'，行级入口用默认 'ghost' */
  variant?: 'ghost' | 'outline' | 'default'
  /** 有则「图标 + 文字」，无则纯图标按钮 */
  label?: string
  className?: string
  disabled?: boolean
}

export function CopyConfigButton({ host, summary, model, variant = 'ghost', label, className, disabled = false }: CopyConfigButtonProps) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const handleClick = () => {
    if (busy || disabled) return
    setBusy(true)
    void (async () => {
      // Key 获取失败时降级：仍复制不含 apiKey 字段的配置，并提示用户先登录管理台。
      let apiKey: string | undefined
      try { apiKey = await host.getApiKey() } catch { apiKey = undefined }
      await host.copy(buildClientConfig(`${resolveEndpointBase(summary.baseUrl)}/v1`, apiKey, model))
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
      if (apiKey === undefined) {
        host.error(new Error('API Key 获取失败，已复制不含 Key 的配置，请先登录管理台'))
      }
    })().catch(host.error).finally(() => setBusy(false))
  }

  return <Button variant={variant} disabled={disabled} busy={busy} onClick={handleClick}
    title={label ?? '复制完整接入配置'} aria-label="复制完整接入配置"
    className={[className, copied ? 'cfg-copied' : ''].filter(Boolean).join(' ')}>
    {copied ? <Check size={15} /> : <Copy size={15} />}{label}
  </Button>
}
