import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import {
  SA_IDLE,
  type SaState,
  saDisarm,
  saOnCancel,
  saOnEnd,
  saOnMove,
  saOnStart,
  saRegisterOpen,
  saShouldSwallowActivation,
  saTranslate,
  saUnregisterOpen,
} from '../lib/swipe-actions.js'

// Swipe-action list row (Soft Ink). Wraps a row so its edit/delete actions
// live in a tray revealed by a leftward swipe (touch), a hover over the row
// (desktop fine pointer — compact icon buttons at the right edge), or Tab
// (the tray buttons are always in the tab order; focus lifts them above the
// content). Pairs with the `.rp-swipe-*` classes in shell.css; the gesture
// math is ../lib/swipe-actions.ts.
//
// The root carries `data-noswipe` so the AppChrome tab-swipe never fires
// from an actionable row, and `touch-action: pan-y` (shell.css) keeps
// vertical scrolling native during the gesture.

export interface SwipeAction {
  key: 'edit' | 'delete' | 'pin'
  /** Accessible name, e.g. `Delete Buy milk`. */
  label: string
  /** Visible tray text when the default per-key copy is wrong for the
   *  verb — e.g. `Leave` / `Remove` on a members list's delete action. */
  text?: string
  /** Compact glyph for the desktop hover-reveal buttons (the touch tray
   *  shows the text). Falls back to the text when omitted. */
  icon?: ReactNode
  onAction: () => void
}

export interface SwipeActionsProps {
  /** Tray actions, laid out left-to-right at the row's right edge. An empty
   *  array renders a plain passthrough wrapper (no tray, no gesture) so
   *  callers keep one code path for rows that are sometimes non-actionable. */
  actions: SwipeAction[]
  /** Rendered wrapper element — `li` when the row lives in a list. */
  as?: 'div' | 'li'
  className?: string
  /** Class for the sliding row element (typically `pl-row`). */
  contentClassName?: string
  contentStyle?: CSSProperties
  /** Extra props spread on the row element — e.g. the row-open handlers. */
  contentProps?: HTMLAttributes<HTMLDivElement>
  children: ReactNode
}

// Default tray copy per key. 'pin' is a toggle, so its two states read
// differently — callers pass `text` to say which ("Unpin"); this is just
// the on-ramp label.
const ACT_TEXT: Record<SwipeAction['key'], string> = {
  edit: 'Edit',
  delete: 'Delete',
  pin: 'Pin',
}

export function SwipeActions({
  actions,
  as = 'div',
  className,
  contentClassName,
  contentStyle,
  contentProps,
  children,
}: SwipeActionsProps) {
  const [state, setState] = useState<SaState>(SA_IDLE)
  const stateRef = useRef(state)
  stateRef.current = state
  const rootRef = useRef<HTMLElement | null>(null)
  const trayRef = useRef<HTMLDivElement | null>(null)
  // Measured when a drag is claimed; the open translate reuses it.
  const trayWidthRef = useRef(0)
  // Clicks fired right after a swipe (or while the tray is open) must not
  // reach the row's own click-to-open handler. Event timestamps share a
  // clock, so remember "swallow until" instead of a boolean that could
  // linger and eat a later legitimate tap.
  const swallowUntilRef = useRef(0)

  const close = useCallback(() => {
    setState((s) => (s.phase === 'idle' ? s : SA_IDLE))
  }, [])

  // If this row unmounts while it owns the open-tray slot, release it.
  useEffect(() => () => saUnregisterOpen(close), [close])

  const isOpen = state.phase === 'open'

  // While open: any outside press or scroll disarms the tray.
  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current
      if (root && e.target instanceof Node && root.contains(e.target)) return
      saDisarm()
    }
    const onScroll = () => saDisarm()
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [isOpen])

  // Type the polymorphic tag as 'div' — the runtime element is whatever
  // `as` names; both accepted tags share the props we pass.
  const Root = as as 'div'

  if (actions.length === 0) {
    return (
      <Root className={className}>
        <div {...contentProps} className={contentClassName} style={contentStyle}>
          {children}
        </div>
      </Root>
    )
  }

  const dragging = state.phase === 'dragging'
  const translate = saTranslate(state, trayWidthRef.current)

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    if (!t) return
    setState((s) => saOnStart(s, t.clientX, t.clientY, e.timeStamp))
  }

  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0]
    if (!t) return
    const prev = stateRef.current
    const next = saOnMove(prev, t.clientX, t.clientY)
    if (next === prev) return
    if (prev.phase !== 'dragging' && next.phase === 'dragging') {
      trayWidthRef.current = trayRef.current?.offsetWidth ?? 0
      // Claiming a drag closes any other open row and takes the slot.
      saRegisterOpen(close)
    }
    setState(next)
  }

  const onTouchEnd = (e: React.TouchEvent) => {
    const prev = stateRef.current
    if (prev.phase === 'idle' || prev.phase === 'open') return
    const { open, next } = saOnEnd(prev, trayWidthRef.current, e.timeStamp)
    if (prev.phase === 'dragging' || prev.openAtStart) {
      // 500ms covers the latest synthetic click browsers fire after a touch
      // drag. A genuine tap landing inside the window is swallowed at most
      // once — the ref resets on first swallow.
      swallowUntilRef.current = e.timeStamp + 500
    }
    setState(next)
    if (open) saRegisterOpen(close)
    else saUnregisterOpen(close)
  }

  const onTouchCancel = () => {
    const prev = stateRef.current
    const next = saOnCancel(prev)
    if (next !== prev) setState(next)
    if (next.phase !== 'open') saUnregisterOpen(close)
  }

  // Shared swallow for both activation paths into the row's own open
  // handler: pointer clicks (onClickCapture) and keyboard Enter/Space on a
  // contentProps row-open handler (onKeyDownCapture — without it, Tab onto
  // an open row + Enter would open the drawer while the tray stayed open).
  // React runs same-element capture handlers before bubble handlers, so
  // stopPropagation here keeps contentProps' onClick/onKeyDown from firing.
  const swallowActivation = (e: React.SyntheticEvent) => {
    const open = stateRef.current.phase === 'open'
    if (saShouldSwallowActivation(stateRef.current, swallowUntilRef.current, e.timeStamp)) {
      e.preventDefault()
      e.stopPropagation()
      swallowUntilRef.current = 0
      if (open) saDisarm()
      return true
    }
    return false
  }

  const onContentClickCapture = (e: React.MouseEvent) => {
    swallowActivation(e)
  }

  const onContentKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') swallowActivation(e)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && stateRef.current.phase === 'open') saDisarm()
  }

  return (
    <Root
      ref={(el) => {
        rootRef.current = el
      }}
      className={
        'rp-swipe' +
        (dragging || isOpen ? ' is-active' : '') +
        (className ? ' ' + className : '')
      }
      data-noswipe="true"
      data-acts={actions.length}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      onKeyDown={onKeyDown}
    >
      <div className="rp-swipe-tray" ref={trayRef}>
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            className={'rp-swipe-act ' + a.key}
            aria-label={a.label}
            onClick={(e) => {
              e.stopPropagation()
              saDisarm()
              close()
              a.onAction()
            }}
          >
            <span className="rp-swipe-act-full">{a.text ?? ACT_TEXT[a.key]}</span>
            <span className="rp-swipe-act-mini" aria-hidden>
              {a.icon ?? a.text ?? ACT_TEXT[a.key]}
            </span>
          </button>
        ))}
      </div>
      <div
        {...contentProps}
        className={'rp-swipe-content' + (contentClassName ? ' ' + contentClassName : '')}
        style={{
          ...contentStyle,
          transform: translate !== 0 ? `translateX(${translate}px)` : undefined,
          transition: dragging ? 'none' : 'transform var(--dur-fast) var(--ease-out)',
        }}
        onClickCapture={onContentClickCapture}
        onKeyDownCapture={onContentKeyDownCapture}
      >
        {children}
      </div>
    </Root>
  )
}
