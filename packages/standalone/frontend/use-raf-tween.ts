/**
 * 动效基础设施：全页唯一 rAF 循环 + 数字滚动 + 入场揭示。
 *
 * 三条来之不易的规矩（改之前先读完）：
 * 1. **数字滚动绝不 setState**。同一个 DOM 节点若被两条补间同时写 textContent，
 *    数字会卡在两条补间的中间值上不动。所以数字一律「ref + 直写 textContent」，
 *    并且每一轮补间开始前先把上一轮标记为失效（active = false）。
 * 2. **只登记一个全局 rAF 循环**。每个组件各自 requestAnimationFrame 会让同一帧
 *    写同一个节点多次，也会在后台标签页堆积回调。这里用模块级 Set 复用单循环，
 *    订阅者为空时立刻停掉循环（不留空转）。
 * 3. **减少动效是三级降级**：CSS 规则归零 + hook 直接写终值且**不登记补间** +
 *    图表一次性画满。「登记了补间又直接写终值」会在下一帧被插值回起点，这条踩过。
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** 减少动效媒体查询（含 iOS 旧语法兜底）。 */
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'

// ---------------------------------------------------------------------------
// 单例媒体查询：整页只挂一个 matchMedia 监听，所有 hook 共享同一份结果。
// ---------------------------------------------------------------------------
interface ReducedMedia {
  query: MediaQueryList | null
  listeners: Set<(next: boolean) => void>
  bound: boolean
}

const reduced: ReducedMedia = { query: null, listeners: new Set(), bound: false }

const reducedQuery = (): MediaQueryList | null => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  if (!reduced.query) reduced.query = window.matchMedia(REDUCED_QUERY)
  return reduced.query
}

const bindReduced = (): void => {
  const query = reducedQuery()
  if (!query || reduced.bound) return
  reduced.bound = true
  const emit = (event: MediaQueryListEvent) => {
    for (const listener of reduced.listeners) listener(event.matches)
  }
  // 老 Safari 只有 addListener；新浏览器走 addEventListener。
  if (typeof query.addEventListener === 'function') query.addEventListener('change', emit)
  else if (typeof query.addListener === 'function') query.addListener(emit)
}

/** 同步读一次「当前是否要求减少动效」——补间每帧都读，绝不能走 state。 */
export const prefersReducedMotionNow = (): boolean => reducedQuery()?.matches ?? false

/** 是否处于后台标签页：后台不让 rAF 空转，也不该写中间值。 */
const pausedNow = (): boolean => typeof document !== 'undefined' && document.hidden

// ---------------------------------------------------------------------------
// 全局单循环
// ---------------------------------------------------------------------------
export type RafTick = (dt: number, now: number) => void

const ticks = new Set<RafTick>()
let rafId = 0
let lastNow = 0

const stopLoop = (): void => {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  lastNow = 0
}

const frame = (now: number): void => {
  // dt 上限 64ms：切回前台或长任务后不让补间跳帧跳过整段动画。
  const dt = lastNow === 0 ? 16 : Math.min(64, now - lastNow)
  lastNow = now
  // 快照遍历：回调里可能增删订阅，直接遍历 Set 会漏项或死循环。
  for (const tick of Array.from(ticks)) tick(dt, now)
  if (ticks.size === 0) { stopLoop(); return }
  rafId = requestAnimationFrame(frame)
}

/** 登记一个帧回调，返回退订函数。整个页面共用同一个 rAF 循环。 */
export const subscribeRaf = (tick: RafTick): (() => void) => {
  ticks.add(tick)
  if (!rafId && typeof requestAnimationFrame === 'function') {
    lastNow = 0
    rafId = requestAnimationFrame(frame)
  }
  return () => {
    ticks.delete(tick)
    if (ticks.size === 0) stopLoop()
  }
}

/**
 * 订阅全局帧循环。
 * @param callback 每帧回调（参数：距上一帧的毫秒数、当前时间戳）；允许在渲染期间换实现。
 * @param active 为 false 时不订阅（组件冻结动效时用）。
 */
export function useRafLoop(callback: RafTick, active = true): void {
  const latest = useRef<RafTick>(callback)
  // 先同步实现，再订阅：两个 effect 按声明顺序执行，保证首帧拿到的是最新闭包。
  useEffect(() => { latest.current = callback })
  useEffect(() => {
    if (!active) return
    return subscribeRaf((dt, now) => latest.current(dt, now))
  }, [active])
}

/** 订阅「是否要求减少动效」，切换时触发一次重渲染（低频，可安全 setState）。 */
export function usePrefersReducedMotion(): boolean {
  const [reducedState, setReducedState] = useState(prefersReducedMotionNow)
  useEffect(() => {
    bindReduced()
    const listener = (next: boolean) => setReducedState(next)
    reduced.listeners.add(listener)
    // 挂载时补一次：首帧读到的值可能早于 matchMedia 初始化。
    setReducedState(prefersReducedMotionNow())
    return () => { reduced.listeners.delete(listener) }
  }, [])
  return reducedState
}

// ---------------------------------------------------------------------------
// 数字滚动
// ---------------------------------------------------------------------------
const defaultFormat = (value: number): string => new Intl.NumberFormat('zh-CN').format(value)

/** 三次缓出：起步快、收尾稳，读数不会像线性那样「匀速爬」。 */
export const easeOutCubic = (progress: number): number => 1 - Math.pow(1 - progress, 3)

export interface NumberTweenOptions {
  /** 补间时长（ms），默认 620。 */
  duration?: number
  /** 起点值：不传则从「当前显示值」续补（轮询更新时不会回跳 0）。 */
  from?: number
  /** 文本格式化；默认中文千分位。 */
  format?: (value: number) => string
  /** 为 true 时直接写终值且不登记补间（?static=1 冻结模式）。 */
  frozen?: boolean
}

interface TweenState {
  /** 当前已写入 DOM 的值（用作下一次补间的起点）。 */
  current: number
  from: number
  to: number
  /** performance.now() 起点；0 表示没有在跑的补间。 */
  start: number
  duration: number
}

/**
 * 把 value 补间写进 elRef 的 textContent。
 * - 全程 ref + 直写 DOM，**不触发 React 重渲染**；
 * - 减少动效 / 后台标签页 / frozen 时直接写终值，且不登记补间。
 */
export function useNumberTween(
  elRef: RefObject<HTMLElement | null>,
  value: number,
  options: NumberTweenOptions = {},
): void {
  const { duration = 620, from, format, frozen = false } = options
  const state = useRef<TweenState>({ current: value, from: value, to: value, start: 0, duration })
  const formatter = useRef<((value: number) => string) | undefined>(format)
  // `from` 只在**首次补间**生效：给入场一个「从 0 滚上来」的起点，
  // 之后的每次数据更新都从当前显示值续补（否则每次轮询都会掉回 0 重新爬）。
  const firstTween = useRef(true)
  useEffect(() => { formatter.current = format })

  const paint = (element: HTMLElement | null, next: number): void => {
    if (!element) return
    element.textContent = (formatter.current ?? defaultFormat)(Math.round(next))
  }

  // 值变化 → 起一段新补间（或直接落终值）。
  useEffect(() => {
    const element = elRef.current
    const stop = (): void => {
      state.current = { current: value, from: value, to: value, start: 0, duration }
      paint(element, value)
    }
    if (frozen || pausedNow() || prefersReducedMotionNow() || !Number.isFinite(value)) { stop(); return }
    const startFrom = firstTween.current && Number.isFinite(from as number) ? (from as number) : state.current.current
    firstTween.current = false
    // 距离太近（差异 < 1）就没必要补间，直接落终值并清掉在跑的补间。
    if (Math.abs(value - startFrom) < 1) { stop(); return }
    state.current = { current: startFrom, from: startFrom, to: value, start: performance.now(), duration }
    paint(element, startFrom)
    // from 只在挂载时提供一次；之后的更新按「当前显示值」续补。
  }, [elRef, value, duration, frozen, from])

  useRafLoop((_dt, now) => {
    const snapshot = state.current
    if (!snapshot.start) return
    const element = elRef.current
    // 元素被卸载 / 用户切到减少动效 / 页面进后台：立刻落终值并解除补间，避免回跳。
    if (!element || prefersReducedMotionNow() || pausedNow()) {
      state.current = { current: snapshot.to, from: snapshot.to, to: snapshot.to, start: 0, duration: snapshot.duration }
      paint(element, snapshot.to)
      return
    }
    const progress = snapshot.duration <= 0 ? 1 : Math.min(1, (now - snapshot.start) / snapshot.duration)
    const next = snapshot.from + (snapshot.to - snapshot.from) * easeOutCubic(progress)
    if (progress >= 1) {
      state.current = { current: snapshot.to, from: snapshot.to, to: snapshot.to, start: 0, duration: snapshot.duration }
      paint(element, snapshot.to)
      return
    }
    state.current = { ...snapshot, current: next }
    paint(element, next)
  })
}

// ---------------------------------------------------------------------------
// 入场揭示
// ---------------------------------------------------------------------------
export interface RevealOptions {
  /** 延迟（ms）：用于逐块错峰（0 / 60 / 120 …）。 */
  delay?: number
  /** 关掉揭示（冻结模式）：立刻视为已揭示。 */
  frozen?: boolean
}

/**
 * 入场揭示门控：返回 true 后调用方给节点加 `is-revealed`，
 * 真正的 0→1 进度交给 CSS transition（只动 opacity / transform，走 GPU 合成）。
 *
 * 为什么不直接返回 0→1 的数字：那样每帧都要 setState 重渲染子树，
 * 或者每帧写 style 触发样式重算——两者都比 CSS 补间贵一个数量级。
 *
 * @param active 数据就绪后才开始（false 时保持未揭示）。
 */
export function useReveal(active = true, options: RevealOptions = {}): boolean {
  const { delay = 0, frozen = false } = options
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) { setShown(false); return }
    if (frozen || prefersReducedMotionNow() || delay <= 0) { setShown(true); return }
    const timer = window.setTimeout(() => setShown(true), delay)
    return () => window.clearTimeout(timer)
  }, [active, delay, frozen])
  return shown
}

/**
 * 快照差集驱动入场：给列表行分配稳定的 key，并在 key 首次出现时播一次 CSS 动画。
 * 返回的函数用于「判断某 key 是否为新行」——新行加 `is-entering` 类即可。
 */
export function createEntranceTracker(limit = 200): (key: string) => boolean {
  const seen = new Set<string>()
  const order: string[] = []
  return (key: string): boolean => {
    if (seen.has(key)) return false
    seen.add(key)
    order.push(key)
    // 只留最近 limit 个 key，避免长会话无限增长。
    while (order.length > limit) {
      const dropped = order.shift()
      if (dropped !== undefined) seen.delete(dropped)
    }
    return true
  }
}

/**
 * 列表差集入场：返回「这一批里首次出现」的 key 集合。
 *
 * 三条要点：
 * 1. `tracker` 必须是**模块级**单例（`createEntranceTracker(...)`）。写成
 *    `useRef(createEntranceTracker())` 的话每次挂载都是新实例，切走再回来整列表
 *    会被当成「全是新行」重放一遍。
 * 2. 差集只在 `source` **换新对象**时算一次 —— 也就是每个轮询周期一次，不是每帧，
 *    所以不会踩「逐帧 setState」那条线；`source` 的 identity 必须稳定，
 *    调用方要用 `useMemo` 包住临时数组（`[...x].filter(...)` 每次都是新数组）。
 * 3. 下一批 `source` 到来时集合整体重算，上一批的 key 自然消失 → 调用方据此摘掉
 *    `is-new` 类。**类名不能一直挂着**：CSS 动画靠类名驱动，残留会让浏览器重放。
 *
 * 第 3 点除了「等下一批」还有一条兜底：`expireMs` 到点后无条件清空。
 * 因为有些场景**根本不会有下一批** —— `?mock=1`（账本钟被停）、`?static=1` 冻结、
 * 后台标签页（钟在但跳过拉取）。没有兜底时 `is-new` 会永久挂在这些行上。
 *
 * @param source 数据源（identity 稳定）
 * @param keyOf 从一条数据取稳定 key
 * @param tracker 模块级 `createEntranceTracker` 实例
 * @param expireMs 强制清空时长（ms）；≤0 表示只靠下一批自然过期
 * @returns 这一批里首次出现的 key 集合（新批到来或过期前保持引用不变）
 */
export function useEntranceDiff<T>(
  source: readonly T[],
  keyOf: (item: T) => string,
  tracker: (key: string) => boolean,
  expireMs = 600,
): ReadonlySet<string> {
  const batch = useRef<{ source: readonly T[] | null; fresh: ReadonlySet<string> }>({
    source: null,
    fresh: new Set<string>(),
  })
  // 只用于「过期」时强制刷一次，不是帧循环。
  const [, bump] = useReducer((count: number) => count + 1, 0)

  // 渲染期派生（同一 `source` 重复渲染时幂等），不走 setState：
  // 多一帧才能拿到类名，会让首行先以终态画出来再「补」一次动画，反而闪。
  if (batch.current.source !== source) {
    const fresh = new Set<string>()
    for (const item of source) {
      const key = keyOf(item)
      if (tracker(key)) fresh.add(key)
    }
    batch.current = { source, fresh }
  }

  const fresh = batch.current.fresh
  useEffect(() => {
    if (expireMs <= 0 || fresh.size === 0) return undefined
    const timer = window.setTimeout(() => {
      // 已经换过批了就别再动（新批的集合可能是另一份）。
      if (batch.current.fresh !== fresh) return
      batch.current = { source: batch.current.source, fresh: new Set<string>() }
      bump()
    }, expireMs)
    return () => window.clearTimeout(timer)
  }, [fresh, expireMs])

  return fresh
}
