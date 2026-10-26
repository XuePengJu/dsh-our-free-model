/**
 * 5 张 KPI 卡 + sparkline。
 *
 * 规矩（改前必读）：
 * - 主数字**只走 `useNumberTween`**（ref + 直写 textContent，绝不 setState）；
 * - sparkline 用 SVG path 直算，不用 canvas（5 条 58×20 的小图不值得起 5 个画布）；
 * - 固定 5 张，**不做第 6 张**（「累计 Token」进第 1 张副行，老板已拍板）；
 * - 缺失值显示 `—`，绝不显示 0。
 */
import { useEffect, useRef } from 'react'
import { HelpCircle } from 'lucide-react'
import { useNumberTween } from '../../use-raf-tween'
import type { KpiCard } from '../../types'

const plainNumber = new Intl.NumberFormat('zh-CN')

/** 千分位；`decimals > 0` 时保留固定小数位（速度类用 1 位）。 */
const makeFormat = (decimals: number) => (value: number): string => {
  if (!Number.isFinite(value)) return '—'
  if (decimals > 0) {
    return value.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  }
  return plainNumber.format(Math.round(value))
}

/** 把一串采样折算成 88×26 viewBox 里的折线路径。 */
const sparkPath = (values: number[], width = 88, height = 26): string => {
  if (values.length < 2) return ''
  let min = values[0]
  let max = values[0]
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  const span = max - min || 1
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width
      // 上下各留 3px：描边不会被 viewBox 裁掉
      const y = height - 3 - ((value - min) / span) * (height - 6)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

interface KpiValueProps {
  value?: number
  decimals: number
  frozen: boolean
}

/** 主数字：ref 交给 useNumberTween 直写，组件本身不因补间重渲染。 */
function KpiValue({ value, decimals, frozen }: KpiValueProps) {
  const ref = useRef<HTMLElement>(null)
  // NaN 会走 hook 的「非有限值」分支直接写成 `—`，且不登记补间。
  // `from: 0` 只在首次补间生效 → 入场时从 0 滚到当前值（原型 k1 的种子补间效果）。
  useNumberTween(ref, value ?? Number.NaN, { from: 0, frozen, format: makeFormat(decimals) })
  return <b ref={ref}>{Number.isFinite(value) ? makeFormat(decimals)(value as number) : '—'}</b>
}

interface UsageKpisProps {
  /** 固定 5 张，顺序即渲染顺序。 */
  cards: KpiCard[]
  /** 冻结动效（?static=1 或 reduced-motion）：直接写终值。 */
  frozen?: boolean
}

/**
 * KPI 卡栅格。
 * @param cards 恰好 5 张；超过 5 张只渲染前 5 张（老板拍板的 5 卡布局，不做第 6 张）
 * @param frozen 冻结动效
 */
export function UsageKpis({ cards, frozen = false }: UsageKpisProps) {
  const visible = cards.slice(0, 5)
  return (
    <div className="r-kpis">
      {visible.map(card => (
        <KpiCardView key={card.key} card={card} frozen={frozen} />
      ))}
    </div>
  )
}

function KpiCardView({ card, frozen }: { card: KpiCard; frozen: boolean }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const firstRender = useRef(true)

  // 数值变化时闪一次边（原型 `.kpi.flash`）：重排强制重绘，只动 box-shadow。
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (frozen) return
    const element = cardRef.current
    if (!element) return
    element.classList.remove('is-flash')
    // 读一次 offsetWidth 让浏览器结算样式，否则连续两次 add 不会重放动画。
    void element.offsetWidth
    element.classList.add('is-flash')
  }, [card.value, frozen])

  const path = sparkPath(card.spark)
  const sparkEmpty = !path

  return (
    <div className="r-kpi" ref={cardRef} title={card.title}>
      <div className="r-kpi-lb">
        {card.label}
        {card.title && <HelpCircle className="r-q" size={11} aria-hidden="true" />}
      </div>
      <div className="r-kpi-val">
        <KpiValue value={card.value} decimals={card.decimals ?? 0} frozen={frozen} />
        {card.unit && <span className="r-u">{card.unit}</span>}
        {card.delta && <span className={`r-kpi-delta${card.delta.flat ? ' is-flat' : ''}`}>{card.delta.text}</span>}
      </div>
      <div className="r-kpi-hint" title={card.hint}>{card.hint}</div>
      <svg
        className={`r-spark is-${card.accent}${sparkEmpty ? ' is-empty' : ''}`}
        viewBox="0 0 88 26"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={path} />
      </svg>
    </div>
  )
}
