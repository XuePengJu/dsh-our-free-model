/**
 * Token 吞吐与速度双轴图（canvas）。
 *
 * 三条来自原型的教训（改之前先看）：
 * 1. **尺寸只认 `ResizeObserver`**。只监听 `window.resize` 会在侧栏折叠、滚动条出现、
 *    字体回流时漏掉尺寸变化，坐标系整块错位。`devicePixelRatio` 取 `Math.min(2, dpr)`，
 *    每帧 `setTransform(dpr,0,0,dpr,0,0)` 重置，否则会越画越缩。
 * 2. **平滑跟随用 ref 里的 Float32Array**（`disp += (target - disp) * 0.16`），
 *    绝不 setState——每帧一次 state 更新会把整棵子树重渲染。
 * 3. **冻结模式（`?static=1` / reduced-motion）一次性画满**：`reveal` 直接置 1，
 *    且不订阅帧循环，只在挂载与尺寸变化时各画一次。
 */
import { useEffect, useRef } from 'react'
import { usePrefersReducedMotion, useRafLoop } from '../../use-raf-tween'
import type { ThroughputSeries } from '../../types'

const numberFormat = new Intl.NumberFormat('zh-CN')

/** 轴标签用的紧凑格式：`1.2M` / `28.5K` / `742`。 */
const compact = (value: number): string => {
  const rounded = Math.round(value || 0)
  if (rounded >= 1e6) return `${Number((rounded / 1e6).toFixed(1))}M`
  if (rounded >= 1e4) return `${Number((rounded / 1e3).toFixed(1))}K`
  return numberFormat.format(rounded)
}

/** 把上界抬到「顺眼」的刻度（1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 × 10^n）。 */
const niceMax = (value: number): number => {
  if (value <= 0) return 10
  const power = Math.pow(10, Math.floor(Math.log10(value)))
  const ratio = value / power
  const multiplier = ratio <= 1 ? 1 : ratio <= 1.5 ? 1.5 : ratio <= 2 ? 2 : ratio <= 2.5 ? 2.5 : ratio <= 3 ? 3 : ratio <= 4 ? 4 : ratio <= 5 ? 5 : 10
  return multiplier * power
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

interface ChartColors {
  grid: string
  text: string
  accent: string
  ok: string
}

interface ChartGeometry {
  width: number
  height: number
  dpr: number
}

interface ChartBuffers {
  /** 平滑后的 Token 序列（逐帧向目标逼近）。 */
  tokens: Float32Array
  /** 平滑后的 tok/s 序列；`NaN` 表示该桶无样本，图上断线。 */
  tps: Float32Array
  length: number
}

interface ThroughputChartProps {
  series: ThroughputSeries
  /** 冻结动效：不订阅帧循环，一次性画满。 */
  frozen?: boolean
  /** 无数据时的替换文案。 */
  emptyText?: string
}

/**
 * 双轴图：实线面积 = Token/桶，虚线 = tok/s，末端带呼吸脉冲点。
 *
 * @param series 两条等长序列（`tps` 里的 null 表示该桶无样本，图上断线而不是画成 0）
 * @param frozen 冻结动效（`?static=1` 或 `prefers-reduced-motion: reduce`）
 */
export function ThroughputChart({ series, frozen = false, emptyText = '所选时段暂无 Token 吞吐样本' }: ThroughputChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const geometry = useRef<ChartGeometry>({ width: 0, height: 0, dpr: 1 })
  const buffers = useRef<ChartBuffers>({ tokens: new Float32Array(0), tps: new Float32Array(0), length: 0 })
  const reveal = useRef(0)
  const latest = useRef<ThroughputSeries>(series)
  const reducedMotion = usePrefersReducedMotion()
  const still = frozen || reducedMotion

  // 序列与冻结标志只在 effect 里同步，避免渲染期间改 ref 带来的时序歧义。
  useEffect(() => {
    latest.current = series
    // 序列长度变了就重建缓冲；长度不变则保留上一条的平滑状态（更新更自然）
    if (buffers.current.length !== series.tokens.length) {
      buffers.current = {
        tokens: Float32Array.from(series.tokens),
        tps: Float32Array.from(series.tps.map(value => value ?? Number.NaN)),
        length: series.tokens.length,
      }
    }
  }, [series])

  const paint = (): void => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const { width, height, dpr } = geometry.current
    if (width < 10 || height < 10) return
    const context = canvas.getContext('2d')
    if (!context) return

    const styles = getComputedStyle(wrap)
    const read = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
    const colors: ChartColors = {
      grid: read('--r-grid-line', 'rgba(255,255,255,.06)'),
      text: read('--r-text-3', '#66738a'),
      accent: read('--r-accent', '#7c8dff'),
      ok: read('--r-ok', '#3ec9a0'),
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)

    const padLeft = 54
    const padRight = 40
    const padTop = 14
    const padBottom = 18
    const chartWidth = width - padLeft - padRight
    const chartHeight = height - padTop - padBottom
    if (chartWidth < 10 || chartHeight < 10) return

    const data = latest.current
    const buffer = buffers.current
    const count = Math.min(data.tokens.length, buffer.length)
    if (count === 0) return

    // 逐帧平滑跟随（冻结时直接对齐，避免「画了一半」的快照）
    const easing = still ? 1 : 0.16
    let maxToken = 0
    let maxTps = 0
    for (let index = 0; index < count; index += 1) {
      const tokenTarget = data.tokens[index]
      buffer.tokens[index] += (tokenTarget - buffer.tokens[index]) * easing
      const tpsTarget = data.tps[index]
      if (tpsTarget == null) {
        buffer.tps[index] = Number.NaN
      } else {
        if (Number.isNaN(buffer.tps[index])) buffer.tps[index] = tpsTarget
        else buffer.tps[index] += (tpsTarget - buffer.tps[index]) * easing
      }
      if (buffer.tokens[index] > maxToken) maxToken = buffer.tokens[index]
      if (!Number.isNaN(buffer.tps[index]) && buffer.tps[index] > maxTps) maxTps = buffer.tps[index]
    }
    const tokenScale = niceMax(maxToken * 1.12)
    const tpsScale = niceMax(Math.max(maxTps, 1) * 1.25)

    // ---- 网格 + 左轴（Token） ----
    context.font = '9.5px ui-monospace, Menlo, monospace'
    context.strokeStyle = colors.grid
    context.lineWidth = 1
    context.fillStyle = colors.text
    context.textBaseline = 'middle'
    context.textAlign = 'right'
    for (let step = 0; step <= 3; step += 1) {
      const y = padTop + chartHeight * (step / 3)
      context.beginPath()
      // +0.5 让 1px 线落在像素中心，避免糊成 2px 灰带
      context.moveTo(padLeft, y + 0.5)
      context.lineTo(width - padRight, y + 0.5)
      context.stroke()
      context.fillText(compact(tokenScale * (1 - step / 3)), padLeft - 7, y)
    }
    // ---- 右轴（tok/s） ----
    context.textAlign = 'left'
    for (let step = 0; step <= 3; step += 1) {
      const y = padTop + chartHeight * (step / 3)
      context.fillText(String(Math.round(tpsScale * (1 - step / 3))), width - padRight + 8, y)
    }

    const xAt = (index: number): number => padLeft + (count <= 1 ? 0 : (index / (count - 1)) * chartWidth)
    const yToken = (value: number): number => padTop + chartHeight * (1 - value / tokenScale)
    const yTps = (value: number): number => padTop + chartHeight * (1 - value / tpsScale)

    // ---- 按 reveal 截断采样点：从左到右「生长」出来 ----
    const limit = still ? 1 : clamp01(reveal.current)
    const visible: [number, number][] = []
    for (let index = 0; index < count; index += 1) {
      if (count > 1 && index / (count - 1) > limit) break
      visible.push([xAt(index), yToken(buffer.tokens[index])])
    }

    if (visible.length > 1) {
      const gradient = context.createLinearGradient(0, padTop, 0, padTop + chartHeight)
      gradient.addColorStop(0, colors.accent)
      gradient.addColorStop(1, 'transparent')
      context.globalAlpha = 0.34
      context.beginPath()
      context.moveTo(visible[0][0], padTop + chartHeight)
      for (const point of visible) context.lineTo(point[0], point[1])
      context.lineTo(visible[visible.length - 1][0], padTop + chartHeight)
      context.closePath()
      context.fillStyle = gradient
      context.fill()
      context.globalAlpha = 1

      context.beginPath()
      visible.forEach((point, index) => { if (index === 0) context.moveTo(point[0], point[1]); else context.lineTo(point[0], point[1]) })
      context.strokeStyle = colors.accent
      context.lineWidth = 1.7
      context.lineJoin = 'round'
      context.stroke()
    }

    // ---- tok/s 虚线（遇到 NaN 就断开，不把缺测画成 0） ----
    const tpsPoints: [number, number][] = []
    context.beginPath()
    let drawing = false
    for (let index = 0; index < count; index += 1) {
      if (count > 1 && index / (count - 1) > limit) break
      const value = buffer.tps[index]
      if (Number.isNaN(value)) { drawing = false; continue }
      const x = xAt(index)
      const y = yTps(value)
      tpsPoints.push([x, y])
      if (!drawing) { context.moveTo(x, y); drawing = true } else context.lineTo(x, y)
    }
    if (tpsPoints.length > 1) {
      context.strokeStyle = colors.ok
      context.lineWidth = 1.3
      context.globalAlpha = 0.9
      context.setLineDash([3, 3])
      context.stroke()
      context.setLineDash([])
      context.globalAlpha = 1
    }

    // ---- 末端脉冲点（只动 canvas 内的半径与透明度，不碰布局） ----
    if (tpsPoints.length > 0) {
      const last = tpsPoints[tpsPoints.length - 1]
      const phase = still ? 0 : (performance.now() % 1800) / 1800
      context.beginPath()
      context.arc(last[0], last[1], 2.2, 0, Math.PI * 2)
      context.fillStyle = colors.ok
      context.fill()
      if (!still) {
        context.beginPath()
        context.arc(last[0], last[1], 2.2 + phase * 7, 0, Math.PI * 2)
        context.strokeStyle = colors.ok
        context.lineWidth = 1
        context.globalAlpha = 0.5 * (1 - phase)
        context.stroke()
        context.globalAlpha = 1
      }
    }
  }

  const paintRef = useRef(paint)
  useEffect(() => { paintRef.current = paint })

  // ---- 尺寸：ResizeObserver 是唯一入口（window.resize 会漏掉侧栏折叠/滚动条） ----
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    let frame = 0
    const measure = (): void => {
      const canvas = canvasRef.current
      if (!canvas) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const width = Math.max(10, wrap.clientWidth - 12)
      const height = Math.max(10, wrap.clientHeight - 14)
      const previous = geometry.current
      if (previous.width === width && previous.height === height && previous.dpr === dpr) return
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      geometry.current = { width, height, dpr }
      // 尺寸变了要立刻重画：等下一帧在冻结模式下永远不会来
      paintRef.current()
    }
    const observer = new ResizeObserver(() => {
      // ResizeObserver 回调本身在渲染前触发，这里再套一帧等布局稳定
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(wrap)
    measure()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  // ---- 帧循环：reveal 推进 + 30fps 节流的绘制 ----
  useRafLoop((dt) => {
    if (!still) reveal.current = Math.min(1, reveal.current + dt / 760)
    const steps = Math.max(1, Math.round(dt / 16))
    // dt 上限 64ms，这里按 16ms 折算成「几帧」，保证 30fps 节流在低帧率机器上不失效
    if (steps % 2 === 0) paintRef.current()
  }, !still)

  // 冻结模式：只在数据变化时重画一次，不订阅帧循环
  useEffect(() => {
    if (still) {
      reveal.current = 1
      paintRef.current()
    }
  }, [still, series])

  // 主题切换（全局 data-theme 属性变化）后重画一次，否则色值仍是旧主题的
  useEffect(() => {
    if (!still) return
    const root = document.documentElement
    const observer = new MutationObserver(() => paintRef.current())
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [still])

  // 空态判定要看**内容**而不只是长度：批次 2 之后桶数组永远是定长的（近 60 分钟 30 桶），
  // 只看长度会让「窗口内一条样本都没有」画成一条贴底的零线 —— 那是在说谎。
  // 真·空 = 所有桶 token 为 0 **且** 所有桶都没有速度样本。
  const empty = series.tokens.length === 0
    || (series.tokens.every(value => value === 0) && series.tps.every(value => value === null))
  const windowMinutes = Math.max(1, Math.round((series.tokens.length * series.bucketMs) / 60000))

  return (
    <div className="r-chart-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="r-chart-canvas" role="img"
        aria-label={`近 ${windowMinutes} 分钟 Token 吞吐与生成速度双轴图`} />
      {empty && <div className="r-chart-empty">{emptyText}</div>}
    </div>
  )
}
