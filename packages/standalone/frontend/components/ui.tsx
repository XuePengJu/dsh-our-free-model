import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Slot } from '@radix-ui/react-slot'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// 按 shadcn 的源码维护方式组合基础组件，只引入本阶段需要的原语。
export const cn = (...values: ClassValue[]) => twMerge(clsx(values))

type ButtonVariant = 'default' | 'outline' | 'ghost'
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

export function Button({ className, variant = 'default', size, busy = false, asChild = false, children, disabled, ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; busy?: boolean; asChild?: boolean; ref?: React.Ref<HTMLButtonElement> }) {
  const Component = asChild ? Slot : 'button'
  return <Component type="button" className={cn('ui-button', `ui-button-${variant}`, size && `ui-button-${size}`, busy && 'is-busy', className)}
    disabled={disabled || busy} data-busy={busy || undefined} {...props}>
    {busy && <Spinner className="ui-button-spinner" aria-hidden="true" />}{children}
  </Component>
}

export function Card({ className, interactive = false, ...props }:
  React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return <div className={cn('ui-card', interactive && 'ui-card-interactive', className)} {...props} />
}

export function Badge({ className, tone = 'neutral', dot = false, children, ...props }:
  React.HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'success' | 'warning' | 'blue'; dot?: boolean }) {
  return <span className={cn('ui-badge', `ui-badge-${tone}`, className)} {...props}>
    {dot && <span className="ui-badge-dot" aria-hidden="true" />}{children}
  </span>
}

export function Input({ className, invalid = false, ...props }:
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input aria-invalid={invalid || undefined} className={cn('ui-input', invalid && 'is-invalid', className)} {...props} />
}

/** 16px 旋转指示器，配合按钮 busy 态或独立使用；只动 transform。 */
export function Spinner({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('ui-spinner', className)} role="status" aria-label="加载中" {...props} />
}

/** 纯 CSS 提示：把文字放到 tip，悬停/聚焦可见。不引入定位依赖。 */
export function Tooltip({ className, tip, children, ...props }:
  React.HTMLAttributes<HTMLSpanElement> & { tip: string }) {
  return <span className={cn('ui-tooltip', className)} data-tip={tip} {...props}>{children}</span>
}

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <kbd className={cn('ui-kbd', className)} {...props} />
}

/** 受控小开关：class 契约与既有 .ui-switch 完全一致（on 表示开启）。 */
export function Switch({ className, checked = false, onCheckedChange, disabled, ...props }:
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & { checked?: boolean; onCheckedChange?: (next: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled}
    className={cn('ui-switch', checked && 'on', className)}
    onClick={event => { props.onClick?.(event); if (!event.defaultPrevented) onCheckedChange?.(!checked) }} {...props}>
    <span aria-hidden="true" />
  </button>
}

export interface DropdownMenuItem {
  key: string
  label: string
  /** 可选图标（lucide-react 节点），展示在文字左侧。 */
  icon?: React.ReactNode
  /** 危险操作：菜单项标红（.menu-item-danger），文案需明确动作而非「确定？」。 */
  danger?: boolean
  disabled?: boolean
  /** 原生 title 提示（保留二段式禁用原因等完整语义）。 */
  title?: string
  /** 选中后是否保持菜单展开（用于两段式确认：第一次点「删除」只武装）。 */
  keepOpen?: boolean
  onSelect: () => void
}

interface DropdownMenuProps {
  /** 触发钮文案（如「数据与工具」）；纯图标触发钮（模型行 ⋯）省略，用 triggerLabel 提供无障碍名。 */
  label?: string
  /** 触发钮的无障碍名称；缺省用 label。 */
  triggerLabel?: string
  icon?: React.ReactNode
  items: DropdownMenuItem[]
  /** 受控展开态：传入后组件不再自持状态（模型行 ⋯ 菜单需要单例互斥）。 */
  open?: boolean
  onOpenChange?: (next: boolean) => void
  /** 菜单因任何路径关闭时回调（用于两段式确认的解除武装）。 */
  onClose?: () => void
  className?: string
  triggerClassName?: string
}

/**
 * 轻量下拉菜单（无外部依赖）：aria-haspopup/expanded + role="menu"/"menuitem"，
 * Esc 与点击外部关闭，关闭后焦点回归触发钮；动画仅 opacity/transform。
 * 支持受控（open + onOpenChange）与非受控两种用法。
 * 弹层通过 createPortal 渲染到 body 并按触发钮矩形 fixed 定位，避免被
 * overflow:auto 的滚动容器（如模型清单 .model-scroll）裁剪；滚动/resize 直接关闭。
 */
export function DropdownMenu({ label, triggerLabel, icon, items, open: openProp, onOpenChange, onClose, className, triggerClassName }: DropdownMenuProps) {
  const [openState, setOpenState] = useState(false)
  const [popStyle, setPopStyle] = useState<React.CSSProperties>()
  const open = openProp ?? openState
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const setOpen = (next: boolean) => {
    setOpenState(next)
    onOpenChange?.(next)
    if (!next) onClose?.()
  }
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node
        && !rootRef.current?.contains(event.target) && !popRef.current?.contains(event.target)) setOpen(false)
    }
    const dismiss = () => setOpen(false)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    // 弹层是按打开瞬间的矩形定位的，不跟随滚动/缩放；容器滚动或窗口变化时直接关闭。
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
    // setOpen 依赖当前渲染闭包，但只读写 setState 与回调，无需列入依赖。
  }, [open])
  // 打开时按触发钮矩形计算弹层 fixed 定位（右对齐，贴触发钮下缘 6px）。
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPopStyle({
      position: 'fixed', top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    })
  }, [open])
  // 关闭后焦点回归触发钮（首次挂载不抢焦点）。
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus({ preventScroll: true })
    wasOpen.current = open
  }, [open])
  return <div ref={rootRef} className={cn('ui-menu', className)}>
    <button ref={triggerRef} type="button"
      className={cn('ui-button ui-button-outline', open && 'is-open', triggerClassName)}
      aria-haspopup="menu" aria-expanded={open} aria-label={triggerLabel ?? label}
      onClick={() => setOpen(!open)}>
      {icon}{label}
    </button>
    {open && popStyle && createPortal(<div ref={popRef} className="ui-menu-pop" role="menu" aria-label={label ?? triggerLabel} style={popStyle}>
      {items.map(item => <button key={item.key} type="button" role="menuitem" disabled={item.disabled}
        title={item.title} className={cn('ui-menu-item', item.danger && 'menu-item-danger')}
        onClick={() => { if (!item.keepOpen) setOpen(false); item.onSelect() }}>
        {item.icon}{item.label}
      </button>)}
    </div>, document.body)}
  </div>
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  body?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作：红色标题 + 红色确认钮。 */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 页内确认弹层（替换原生 window.confirm）：焦点进入确认钮，Esc = 取消，
 * 点击遮罩取消；危险样式红色标题 + 红确认钮，确认语义原文由调用方保留。
 */
export function ConfirmDialog({ open, title, body, confirmText = '确认', cancelText = '取消', danger = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onCancel])
  if (!open) return null
  return <div className="confirm-overlay" role="presentation"
    onPointerDown={event => { if (event.target === event.currentTarget) onCancel() }}>
    <div className={cn('confirm-dialog', danger && 'is-danger')} role="alertdialog" aria-modal="true" aria-label={title}>
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      <div className="confirm-dialog-actions">
        <Button variant="outline" onClick={onCancel}>{cancelText}</Button>
        <Button ref={confirmRef} className={danger ? 'danger-button' : undefined} onClick={onConfirm}>{confirmText}</Button>
      </div>
    </div>
  </div>
}
