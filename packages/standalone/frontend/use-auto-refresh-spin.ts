import { useEffect, useRef, useState } from 'react'

/**
 * app 层每 5 秒自动轮询 loadData 时广播 window 事件 ofm:refresh-start / ofm:refresh-end，
 * 本 hook 把它转成「正在刷新」布尔值，供「更新状态 / 更新统计」按钮图标转圈示意。
 * 本机接口几十毫秒就返回，直接跟随事件会一闪而过——最短转 600ms 保证肉眼可见。
 * 消费方只负责把返回值拼进图标 className，不禁用按钮、不换文案
 * （「正在更新」文案与禁用只留给用户手动点击，避免每 5 秒闪一次）。
 */
export function useAutoRefreshSpin() {
  const [spinning, setSpinning] = useState(false)
  const startedAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useEffect(() => {
    const onStart = () => { startedAt.current = Date.now(); if (timer.current) clearTimeout(timer.current); setSpinning(true) }
    const onEnd = () => {
      const remain = Math.max(0, 600 - (Date.now() - startedAt.current))
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setSpinning(false), remain)
    }
    window.addEventListener('ofm:refresh-start', onStart)
    window.addEventListener('ofm:refresh-end', onEnd)
    return () => { window.removeEventListener('ofm:refresh-start', onStart); window.removeEventListener('ofm:refresh-end', onEnd) }
  }, [])
  return spinning
}
