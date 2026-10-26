/**
 * 路由实况（hero 整块）：来源卡 → 网关 → 候选链 + 连线 + 本次请求条 + 裁决与三大数字。
 *
 * 几何与动效的分工（照抄原型的经验）：
 * - **连线几何只在「尺寸变化 / 候选集合变化 / 命中变化」时重算**，不在帧循环里算；
 *   路径用 `getBoundingClientRect` 相对容器求坐标，所以容器尺寸必须走
 *   `ResizeObserver`（侧栏折叠、滚动条出现都不触发 `window.resize`）。
 * - **流动效果是纯 CSS**（`stroke-dashoffset` + `opacity`），JS 只负责切类名。
 * - 候选行状态是**六态**（`pending | probing | active | done | skipped | failed`），
 *   批次 5 的 `UsageAttempt.outcome` 直接映射进来，组件结构不用改。
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { CurrentRequest, RoutingCandidate, RoutingSource, RoutingTotals, UsageAttempt, Verdict } from '../../types'

const numberFormat = new Intl.NumberFormat('zh-CN')

/**
 * 网关监听端口：从 `location` 取（同源页面一定能读到）；异常/SSR 时回退默认端口。
 *
 * hero 里有两处要显示端口 —— 左列来源卡的地址、中间网关枢纽的 `:port` —— 它们必须
 * 指向同一个实例。`--port` 换过端口的实例（例如并行起第二个做核对）如果只改一处，
 * 同一块卡片里就会出现「127.0.0.1:18903」和「:18900」并存，所以这里统一出口。
 */
export const gatewayPort = (): string => {
  try {
    if (location.port !== '') return location.port
    return location.protocol === 'https:' ? '443' : '80'
  } catch {
    return '18900'
  }
}

const format = (value: number): string => numberFormat.format(Math.round(value || 0))

/** 单个候选行最多展示 8 行，其余折叠成「+N 个」（方案 §9.2 的性能红线）。 */
const MAX_CANDIDATES = 8

/** 两点之间的三次贝塞尔：控制点按水平距离的 42% 前伸，视觉上像「软管」而不是折线。 */
const curve = (x1: number, y1: number, x2: number, y2: number): string => {
  const dx = Math.max(24, (x2 - x1) * 0.42)
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
}

/** 标签语义 → 样式类（与 usage-routing.css 的 `.r-lbl.is-*` 对应）。 */
const labelClass = (kind: RoutingCandidate['labelKind']): string => `r-lbl is-${kind}`

/** 走查回合的相对时间：只分三档（刚刚 / N 分钟前 / N 小时前），不引入日期库。 */
const relativeTurnTime = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.round(minutes / 60)} 小时前`
}

/** 速度文本：缺失显示 `—`，绝不显示 0。 */
const speedText = (tps?: number): string => (tps == null || !Number.isFinite(tps) ? '—' : tps.toFixed(1))

/**
 * 速度区是否用「待命」样式（灰小字）：
 * 未到达 / 正在探测 / 没有样本的候选都算——它们显示的是渠道均值或占位符，不是本次实测值。
 */
const isIdleSpeed = (candidate: RoutingCandidate): boolean =>
  candidate.state === 'pending' || candidate.state === 'probing' || candidate.tps == null

interface RoutingLiveProps {
  /** 左栏来源卡（哪几路客户端在打网关）。 */
  sources: RoutingSource[]
  /** 当前链 id，用于描述行与网关模式。 */
  activeChainId: string
  /** 链策略展示名（`顺序降级` / `直连`）。 */
  chainStrategyLabel?: string
  /** 右栏候选链，顺序即尝试顺序。 */
  candidates: RoutingCandidate[]
  /** 本次请求条；无进行中请求时传 null。 */
  current: CurrentRequest | null
  /** 一句话裁决 + 彩色要点。 */
  verdict: Verdict
  /** 底部三个大数字。 */
  totals: RoutingTotals
  /**
   * B 档真实 attempts（最近一个回合的行）。仅用于 aria-label 的条数提示，
   * 渲染口径仍由 `candidates` 的 `state`/`label` 决定，本组件不重算状态。
   */
  attempts?: UsageAttempt[]
  /** 最近一个走查回合的起点（毫秒）。无记录时不传 —— 说明这条链还没走过。 */
  turnAt?: number
  /** 冻结动效（`?static=1`）。 */
  frozen?: boolean
}

/**
 * 路由实况整块。
 *
 * @param candidates 候选链（六态）；超过 8 行折叠为「+N 个候选」
 * @param attempts B 档 attempts，仅用于 aria-label 的条数提示，渲染口径仍由 candidates 决定
 */
export function RoutingLive({
  sources,
  activeChainId,
  chainStrategyLabel = '顺序降级',
  candidates,
  current,
  verdict,
  totals,
  attempts,
  turnAt,
  frozen = false,
}: RoutingLiveProps) {
  const routeRef = useRef<HTMLDivElement>(null)
  const wiresRef = useRef<SVGSVGElement>(null)

  // 连线几何：命令式写 SVG（路径数量随候选数变化，React 里维护 diff 不划算）。
  const drawWires = useCallback(() => {
    const route = routeRef.current
    const svg = wiresRef.current
    if (!route || !svg) return
    const box = route.getBoundingClientRect()
    // 容器还没布局完（display:none 或首帧宽度为 0）时画出来全是错位线条，直接跳过
    if (box.width < 10) return
    svg.setAttribute('width', String(box.width))
    svg.setAttribute('height', String(box.height))
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`)

    const hub = route.querySelector<HTMLElement>('.r-hub')
    if (!hub) return
    const hubBox = hub.getBoundingClientRect()
    const hubLeft = hubBox.left - box.left - 8
    const hubRight = hubBox.right - box.left + 8
    const hubY = hubBox.top - box.top + hubBox.height / 2

    const paths: SVGPathElement[] = []
    const append = (d: string, stroke: string, className: string): void => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d)
      path.setAttribute('stroke', stroke)
      path.setAttribute('class', className)
      paths.push(path)
    }

    route.querySelectorAll<HTMLElement>('.r-src-card').forEach((card, index) => {
      const cardBox = card.getBoundingClientRect()
      const x1 = cardBox.right - box.left + 2
      const y1 = cardBox.top - box.top + cardBox.height / 2
      const on = sources[index]?.active === true
      append(curve(x1, y1, hubLeft, hubY), sources[index]?.accent ?? 'currentColor', `r-wire${on ? ' is-on' : ''}`)
    })

    const rows = route.querySelectorAll<HTMLElement>('.r-cand')
    rows.forEach((row, index) => {
      const rowBox = row.getBoundingClientRect()
      const x2 = rowBox.left - box.left - 2
      const y2 = rowBox.top - box.top + rowBox.height / 2
      const state = candidates[index]?.state
      const accent = candidates[index]?.accent ?? 'currentColor'
      const modifier = state === 'active' ? ' is-on' : state === 'skipped' || state === 'failed' ? ' is-dim' : ''
      append(curve(hubRight, hubY, x2, y2), accent, `r-wire${modifier}`)
    })

    // 一次性替换：命中线（is-on）最后画，避免被其它线压住
    svg.replaceChildren(...paths)
  }, [sources, candidates])

  // 布局阶段画：等到这一帧的样式结算完，rect 才是最终值
  useLayoutEffect(() => {
    drawWires()
  }, [drawWires])

  // 容器尺寸变化（侧栏折叠 / 滚动条 / 断点切换）→ 重算几何
  useEffect(() => {
    const route = routeRef.current
    if (!route) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => drawWires())
    })
    observer.observe(route)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [drawWires])

  const visible = candidates.slice(0, MAX_CANDIDATES)
  const hidden = candidates.length - visible.length
  const busy = visible.some(candidate => candidate.state === 'active' || candidate.state === 'probing')
  // 进度条：批次 1 没有真实 token 流，用 1200 tok 的参考长度折算（批次 3 换成实时累计值）
  const progress = current ? Math.min(1, current.outputTokens / 1200) : 0

  return (
    <section className="r-hero" data-testid="usage-route-live" data-static={frozen ? 'true' : undefined}>
      <div className="r-hero-head">
        <div>
          <div className="r-hero-title">
            路由实况
            <span className="r-tagline">live, as the gateway decides</span>
          </div>
          <p className="r-hero-desc">
            <b>{activeChainId}</b> · {chainStrategyLabel} · <b>{candidates.length}</b> 个候选取其一。
            按链序逐个尝试，每个成员用自己的渠道账号与额度，前一个限流就换下一个。
          </p>
          {/* 走查回合的年龄必须标出来：回合是历史事实，不标时间会把「上次的走查」
              误读成「正在发生的请求」（进行中与否看来源卡的「处理中」徽标）。 */}
          <p className="r-tagline">
            {turnAt === undefined
              ? '还没有这条链的走查记录，发一条消息就会出现在这里'
              : `最近一次降级走查 · ${relativeTurnTime(turnAt, Date.now())}`}
          </p>
        </div>
      </div>

      <div className="r-route" ref={routeRef}>
        <svg className="r-wires" ref={wiresRef} preserveAspectRatio="none" aria-hidden="true" />

        <div className="r-src-col">
          {sources.map(source => (
            <div key={source.id} className={`r-src-card${source.active ? ' is-active' : ''}`}>
              <div className="r-src-badge">处理中</div>
              <div className="r-nm">
                <span className="r-pt" style={{ background: source.accent }} />
                {source.name}
              </div>
              <div className="r-sub" title={source.sub}>{source.sub}</div>
            </div>
          ))}
          {sources.length === 0 && <div className="r-cand-more">当前没有进行中的请求</div>}
        </div>

        <div className="r-hub-col">
          <div className={`r-hub${busy ? ' is-busy' : ''}`}>
            <div className="r-glyph" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
                <path d="M5 19V9M12 19V5M19 19v-6" />
              </svg>
            </div>
            <b>dsh gateway</b>
            <span className="r-addr">:{gatewayPort()}</span>
            <span className="r-mode">{chainStrategyLabel}</span>
          </div>
        </div>

        <div
          className="r-dst-col"
          aria-label={attempts && attempts.length > 0 ? `候选链，含 ${attempts.length} 条尝试记录` : '候选链'}
        >
          {visible.map((candidate, index) => (
            <div key={candidate.candidateId} className={`r-cand is-${candidate.state}`}>
              <div className="r-idx">{index + 1}</div>
              <div className="r-av" style={{ background: candidate.accent }} aria-hidden="true">{candidate.providerShort}</div>
              <div className="r-who">
                <span className="r-ch">{candidate.providerName}</span>
                <span className="r-md" title={candidate.model}>{candidate.model}</span>
                <span className="r-acct">{candidate.account}</span>
              </div>
              <div className="r-st">
                {/* 未到达的候选显示渠道平均速度（灰小字），让用户能横向比较链上候选 */}
                <div className={`r-spd${isIdleSpeed(candidate) ? ' is-idle' : ''}`}>
                  <b>{speedText(candidate.tps)}</b>
                  <i>tok/s</i>
                </div>
                <span className={labelClass(candidate.labelKind)} title={candidate.reason}>
                  {candidate.labelKind === 'answering' && <span className="r-lbldot" aria-hidden="true" />}
                  {candidate.label}
                </span>
              </div>
            </div>
          ))}
          {hidden > 0 && <div className="r-cand-more">还有 {hidden} 个候选</div>}
        </div>
      </div>

      <div className="r-thisreq">
        <div className="r-cell">
          <span className="r-k">本次请求</span>
          <span className="r-v">{current?.id ?? '—'}</span>
        </div>
        <div className="r-cell">
          <span className="r-k">命中</span>
          <span className={`r-v${current?.hit ? ' is-win' : ''}`}>{current?.hit ?? '—'}</span>
        </div>
        <div className="r-cell">
          <span className="r-k">首字</span>
          <span className="r-v">{current?.ttftMs == null ? '— ms' : `${Math.round(current.ttftMs)} ms`}</span>
        </div>
        <div className="r-cell">
          <span className="r-k">速度</span>
          <span className={`r-v${current?.tps != null ? ' is-win' : ''}`}>
            {current?.tps == null ? '— tok/s' : `${current.tps.toFixed(1)} tok/s`}
          </span>
        </div>
        <div className="r-cell">
          <span className="r-k">输出</span>
          <span className="r-v">{current ? `${format(current.outputTokens)} tok` : '— tok'}</span>
        </div>
        <div className="r-cell r-grow">
          <div className="r-bar">
            <i style={{ transform: `scaleX(${progress.toFixed(3)})` }} />
          </div>
        </div>
      </div>

      <div className="r-hero-foot">
        <div className="r-verdict">
          <p>{verdict.text}</p>
          <div className="r-why">
            {verdict.bullets.map(bullet => (
              <span className="r-bullet" key={bullet.text}>
                <span className="r-kdot" style={{ background: bullet.color }} />
                {bullet.text}
              </span>
            ))}
          </div>
        </div>
        <div className="r-bignums">
          <div className="r-bn">
            <b>{format(totals.requests)}</b>
            <span>本小时请求</span>
          </div>
          <div className="r-bn is-hot">
            <b>{format(totals.reroutes)}</b>
            <span>降级接管</span>
          </div>
          <div className="r-bn is-bad">
            <b>{format(totals.errors)}</b>
            <span>客户端看到的错误</span>
          </div>
        </div>
      </div>
    </section>
  )
}
