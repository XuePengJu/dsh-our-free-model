import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { Input } from './ui'
import { settingsDraft, syncSettings, validateSettingsDraft } from '../settings-data.mjs'
import type { Host, Summary } from '../types'
import '../settings.css'

type Draft = ReturnType<typeof settingsDraft>
type NumberField = 'defaultMaxTokens' | 'probeIntervalMinutes'
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

/** 改动后等这么久再发请求：数字框连续输入只落一次盘。 */
const SAVE_DEBOUNCE_MS = 400

const connectionError = (reason: unknown) => reason instanceof Error
  ? reason.name === 'TimeoutError' ? '保存超时，结果尚未确认'
    : reason instanceof TypeError && /fetch/i.test(reason.message) ? '无法连接本地服务'
    : reason.message : '保存失败'

/**
 * 概览页「运行检查」卡里的模型刷新设置。
 *
 * 剪裁后只有这一组设置仍需在界面上调整（刷新节奏与自动探测）。总开关与输出上限
 * 已移除：服务默认就是开着的，不想用直接退出应用即可；输出上限对渠道模型本就不生效。
 *
 * **改动即保存**：不再有「保存 / 撤销」按钮。数字框防抖 400ms，开关同走防抖
 * （视觉状态本地即时生效，落盘略有延迟，用户感知不到）；校验不通过时只显示行内
 * 错误、不发请求，避免把半截输入写进配置。
 */
export function useServiceSettings(summary: Summary, host: Host) {
  const [state, setState] = useState(() => ({ saved: summary.settings, draft: settingsDraft(summary.settings) }))
  const [errors, setErrors] = useState<Partial<Record<NumberField, string>>>({})
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState('')
  const draftRef = useRef(state.draft)
  draftRef.current = state.draft
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef(false)
  const inflight = useRef(false)
  const mounted = useRef(true)

  const flush = useCallback(async (): Promise<void> => {
    pending.current = false
    // 上一次还在飞：等它落地后再补一次，避免两次请求互相覆盖。
    if (inflight.current) { pending.current = true; return }
    const validation = validateSettingsDraft(draftRef.current)
    setErrors(validation.errors)
    if (!validation.patch) { setStatus('idle'); return }
    inflight.current = true
    setStatus('saving'); setError('')
    try {
      const saved = await host.saveSettings(validation.patch)
      if (!mounted.current) return
      // 只更新「已保存」基线，草稿保持用户当下的输入（期间可能又改过）。
      setState(previous => ({ saved, draft: previous.draft }))
      setStatus('saved')
      void host.refresh().catch(() => { /* 刷新失败不影响已确认的保存 */ })
    } catch (reason) {
      if (!mounted.current) return
      setStatus('error'); setError(connectionError(reason))
    } finally {
      inflight.current = false
      if (pending.current && mounted.current) void flush()
    }
  }, [host])

  const schedule = useCallback((): void => {
    pending.current = true
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { void flush() }, SAVE_DEBOUNCE_MS)
  }, [flush])

  // 卸载时清定时器，并把还没落盘的改动补发一次（切页/关窗不丢设置）。
  useEffect(() => () => {
    window.clearTimeout(timer.current)
    if (pending.current) void flush()
    mounted.current = false
  }, [flush])

  // 服务端轮询值只在「草稿没有未保存改动」时同步进草稿，不覆盖正在编辑的输入。
  useEffect(() => {
    setState(previous => syncSettings(previous, summary.settings, inflight.current))
  }, [summary.settings])

  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setState(previous => ({ ...previous, draft: { ...previous.draft, [key]: value } }))
    setErrors(previous => ({ ...previous, [key]: undefined }))
    setError('')
    schedule()
  }

  return { draft: state.draft, errors, status, error, update, retry: flush }
}

export type ServiceSettingsForm = ReturnType<typeof useServiceSettings>

/** 模型刷新：节奏与自动探测。 */
export function RefreshSettings({ form, automaticRefresh }: { form: ServiceSettingsForm; automaticRefresh: boolean }) {
  const message = form.errors.probeIntervalMinutes
  return <>
    <div className="settings-field settings-number-field">
      <label htmlFor="setting-probeIntervalMinutes"><strong>刷新间隔（分钟）</strong>
        <small>1–1440 分钟，改动后重新安排下一轮。</small></label>
      <div className="settings-number">
        <Input id="setting-probeIntervalMinutes" name="probeIntervalMinutes" type="number" min={1} max={1440} step={1}
          value={form.draft.probeIntervalMinutes} disabled={form.status === 'saving'}
          onChange={event => form.update('probeIntervalMinutes', event.target.value)}
          aria-invalid={!!message} aria-describedby={message ? 'setting-error-probeIntervalMinutes' : undefined} />
        {message
          ? <p id="setting-error-probeIntervalMinutes" className="settings-field-error" role="alert"><CircleAlert size={12} />{message}</p>
          : null}
      </div>
    </div>
    <label className="settings-field">
      <span><strong>自动探测可用性</strong><small>周期刷新时发送探测请求，消耗上游额度；遇到限流会自动退避。</small></span>
      <input type="checkbox" role="switch" name="standaloneProbe" className="settings-toggle"
        checked={form.draft.standaloneProbe} disabled={form.status === 'saving'}
        onChange={event => form.update('standaloneProbe', event.target.checked)} />
    </label>
    <p className="settings-note" role="note"><CircleAlert size={15} /><span>{automaticRefresh
      ? '自动刷新已启用，改动间隔后立即生效。'
      : '当前以 --no-refresh 启动。设置会保存，但自动任务保持暂停；手动刷新仍可用。'}</span></p>
  </>
}

/** 卡头右侧的保存状态：没有按钮，只报事实。 */
export function SaveState({ form }: { form: ServiceSettingsForm }) {
  if (form.status === 'error') {
    return <span className="ov-save-state is-error" role="status" aria-live="polite">
      <CircleAlert size={12} />
      <button type="button" className="ov-save-retry" onClick={() => { void form.retry() }}>{form.error}·点此重试</button>
    </span>
  }
  const text = form.status === 'saving' ? '正在保存…' : form.status === 'saved' ? '已自动保存' : '改动即自动保存'
  return <span className={`ov-save-state${form.status === 'saved' ? ' is-saved' : ''}`} role="status" aria-live="polite">
    {form.status === 'saving' ? <LoaderCircle size={12} className="spinning" />
      : form.status === 'saved' ? <Check size={12} /> : null}
    <span>{text}</span>
  </span>
}
