/**
 * 实时请求流（6 行）。
 *
 * - 行入场是**差分**的：只有 tracker 头一次见到的 key 才加 `is-new` 播一次
 *   淡入 + 4px 上移，已有行不重排、不重放；切走再回来也不会整列表重播；
 * - 每行可点：跳到请求日志页看逐条 14 列明细（方案 §3.6 的迁移出口之一）；
 * - 只展示 6 行，逐条全明细归日志页，看板不重复渲染。
 */
import { useMemo } from 'react'
import { ArrowRight } from 'lucide-react'
import { createEntranceTracker, useEntranceDiff } from '../../use-raf-tween'
import type { CSSProperties } from 'react'
import type { StreamRow } from '../../types'

/**
 * 「见过哪些行」的记忆必须跨挂载存活，所以放**模块级**。
 * 用 `useRef(createEntranceTracker())` 的话每次挂载都是新实例，
 * 从别页切回来会被当成「6 行全新的」整列表重放一遍。
 */
const streamEntrance = createEntranceTracker(400)

const numberFormat = new Intl.NumberFormat('zh-CN')

const hhmmss = (at: number): string => {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const format = (value: number): string => numberFormat.format(Math.round(value || 0))

interface RequestStreamProps {
  /** 最新在前；组件按 `limit` 截断。 */
  rows: StreamRow[]
  /** 展示行数，默认 6。 */
  limit?: number
  /** 点行 / 点页脚出口时跳转到请求日志页。 */
  onOpenLogs?: () => void
  /**
   * 空态文案（由调用方给）。
   *
   * 账本「空」至少有三种原因：从未跑过请求 / 账本读取失败 / 还在加载。
   * 各写一句才说得清，组件不猜。
   */
  emptyText?: string
}

/**
 * 实时请求流。
 *
 * @param rows 最新在前，`key` 需稳定（`at:model:idx`）
 * @param limit 最多展示多少行（默认 6）
 */
export function RequestStream({ rows, limit = 6, onOpenLogs, emptyText }: RequestStreamProps) {
  // identity 必须稳定：`rows.slice()` 每次渲染都是新数组，会让差集每个渲染都重算。
  const visible = useMemo(() => rows.slice(0, limit), [rows, limit])
  // 这一批里「首次见到」的行 key。下一个轮询周期 `visible` 换新对象时整体重算，
  // 上一批的 key 从集合里消失 → `is-new` 自动摘掉，CSS 不会重放。
  const fresh = useEntranceDiff(visible, row => row.key, streamEntrance)
  return (
    <section className="r-panel">
      <div className="r-panel-head">
        <h3>实时请求</h3>
        <span className="r-panel-sub">逐条带渠道与速度</span>
        <div className="r-tool">
          <span className="r-legend">{visible.length} 条</span>
        </div>
      </div>
      <div className="r-stream">
        {visible.length === 0 && <div className="r-stream-empty">{emptyText ?? '还没有已结算的请求，发一条消息就会出现在这里。'}</div>}
        {visible.map((row, index) => {
          const content = (
            <>
              <div className="r-t">{hhmmss(row.at)}</div>
              <div className="r-body">
                <div className="r-l1">
                  <span className="r-pt" style={{ background: row.failed ? 'var(--r-bad)' : row.accent }} />
                  <span>{row.provider}</span>
                  <span className="r-mo" title={row.model}>{row.model}</span>
                </div>
                <div className="r-l2">
                  {row.account} · 首字 {row.ttftMs == null ? '—' : `${Math.round(row.ttftMs)}ms`} · {row.tokens == null ? '—' : format(row.tokens)} tok
                </div>
              </div>
              <div className="r-right">
                <b>{row.failed ? '失败' : row.tps == null ? '—' : row.tps.toFixed(1)}</b>
                <span>tok/s</span>
              </div>
            </>
          )
          return (
            <div
              key={row.key}
              className={`r-tick${row.failed ? ' is-fail' : ''}${fresh.has(row.key) ? ' is-new' : ''}`}
              // 逐行错峰 30ms：入场是 opacity/transform 动画，不会引起重排
              style={{ '--r-delay': `${Math.min(index, 6) * 30}ms` } as CSSProperties}
              title={row.reason ?? `${row.provider} · ${row.model} · ${row.account}`}
            >
              {onOpenLogs ? (
                <button type="button" className="r-tick-button" onClick={() => onOpenLogs()}
                  aria-label={`查看 ${row.provider} ${row.model} 的请求明细`}>
                  {content}
                </button>
              ) : content}
            </div>
          )
        })}
      </div>
      <div className="r-stream-foot">
        <button type="button" onClick={() => onOpenLogs?.()}>
          在请求日志里看全部 <ArrowRight size={11} aria-hidden="true" />
        </button>
      </div>
    </section>
  )
}
