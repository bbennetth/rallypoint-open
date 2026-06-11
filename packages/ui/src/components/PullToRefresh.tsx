import { useEffect, useRef, useState } from 'react'
import { useConnectionStore } from '../store/connection.js'
import {
  PTR_IDLE,
  PTR_THRESHOLD,
  type PtrState,
  ptrIndicatorTranslate,
  ptrOnEnd,
  ptrOnMove,
  ptrOnStart,
  ptrSyncCycleStatus,
} from '../lib/pull-to-refresh.js'

export interface PullToRefreshProps {
  // Scroll container the gesture is attached to. Usually the main
  // app scroll surface (an inner div in `AttendeeChrome`).
  scrollRef: React.RefObject<HTMLElement | null>
  // Triggered when the gesture commits. Return `false` (sync) to
  // skip the connection-store handshake — the indicator will clear
  // after the safety timeout. Anything else (or void) flips
  // `synced=false` so the next SSE welcome closes the cycle.
  onRefresh: () => boolean | void
  // Hide entirely (e.g. desktop layouts where pull-to-refresh isn't
  // a thing). When toggled true mid-gesture, state resets.
  disabled: boolean
}

const COOLDOWN_SAFETY_MS = 4_000
const RESET_AFTER_DONE_MS = 700
type FinishState = 'none' | 'synced' | 'timeout'

// Mobile pull-to-refresh on the app's main scroll surface. The pull
// gesture commits past `PTR_THRESHOLD` and calls `onRefresh()`. The
// indicator clears once the connection-store flips `synced=false`
// and then `synced=true` again, or clears after a safety timeout so
// the user isn't left staring at a spinner if the server is
// unreachable.
export function PullToRefresh({ scrollRef, onRefresh, disabled }: PullToRefreshProps) {
  const [state, setState] = useState<PtrState>(PTR_IDLE)
  const [finish, setFinish] = useState<FinishState>('none')
  const stateRef = useRef(state)
  const sawUnsyncedRef = useRef(false)
  stateRef.current = state

  const synced = useConnectionStore((s) => s.synced)

  useEffect(() => {
    if (state.phase !== 'cooldown' || finish !== 'none') return
    const safety = setTimeout(() => {
      setFinish('timeout')
    }, COOLDOWN_SAFETY_MS)
    return () => clearTimeout(safety)
  }, [state.phase, finish])

  useEffect(() => {
    if (state.phase !== 'cooldown' || finish !== 'none') return
    const next = ptrSyncCycleStatus(sawUnsyncedRef.current, synced)
    sawUnsyncedRef.current = next.sawUnsynced
    if (next.complete) setFinish('synced')
  }, [state.phase, synced, finish])

  useEffect(() => {
    if (finish === 'none') return
    const t = setTimeout(() => {
      setFinish('none')
      sawUnsyncedRef.current = false
      setState(PTR_IDLE)
    }, RESET_AFTER_DONE_MS)
    return () => clearTimeout(t)
  }, [finish])

  useEffect(() => {
    if (disabled) {
      setState(PTR_IDLE)
      setFinish('none')
      sawUnsyncedRef.current = false
      return
    }
    const el = scrollRef.current
    if (!el) return

    const currentScrollTop = () => {
      const documentScrollTop = Math.max(
        0,
        window.scrollY,
        document.documentElement?.scrollTop ?? 0,
        document.body?.scrollTop ?? 0,
      )
      return Math.max(el.scrollTop, documentScrollTop)
    }

    const handleStart = (e: TouchEvent) => {
      if (stateRef.current.phase === 'cooldown') return
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      if (!touch) return
      const next = ptrOnStart(currentScrollTop(), touch.clientY)
      if (next.startY !== stateRef.current.startY || next.phase !== stateRef.current.phase) {
        setState(next)
      }
    }

    const handleMove = (e: TouchEvent) => {
      if (stateRef.current.phase === 'cooldown') return
      const touch = e.touches[0]
      if (!touch) return
      const next = ptrOnMove(stateRef.current, currentScrollTop(), touch.clientY)
      if (next.phase === 'pulling' || next.phase === 'committed') {
        if (e.cancelable) e.preventDefault()
      }
      if (
        next.phase !== stateRef.current.phase ||
        next.deltaY !== stateRef.current.deltaY
      ) {
        setState(next)
      }
    }

    const handleEnd = () => {
      const { commit, next } = ptrOnEnd(stateRef.current)
      setState(next)
      if (commit) {
        setFinish('none')
        sawUnsyncedRef.current = false
        try {
          const started = onRefresh()
          if (started === false) {
            setFinish('timeout')
            return
          }
          useConnectionStore.getState().setSynced(false)
        } catch {
          setFinish('timeout')
        }
      }
    }

    el.addEventListener('touchstart', handleStart, { passive: true })
    el.addEventListener('touchmove', handleMove, { passive: false })
    el.addEventListener('touchend', handleEnd)
    el.addEventListener('touchcancel', handleEnd)

    const reset = () => {
      setState(PTR_IDLE)
      setFinish('none')
      sawUnsyncedRef.current = false
    }
    window.addEventListener('orientationchange', reset)
    window.addEventListener('resize', reset)

    return () => {
      el.removeEventListener('touchstart', handleStart)
      el.removeEventListener('touchmove', handleMove)
      el.removeEventListener('touchend', handleEnd)
      el.removeEventListener('touchcancel', handleEnd)
      window.removeEventListener('orientationchange', reset)
      window.removeEventListener('resize', reset)
    }
  }, [scrollRef, onRefresh, disabled])

  if (disabled) return null

  const label =
    state.phase === 'cooldown'
      ? finish === 'synced'
        ? 'Connected'
        : finish === 'timeout'
          ? 'Still reconnecting'
          : 'Reconnecting…'
      : state.phase === 'committed'
        ? 'Release to reconnect'
        : state.phase === 'pulling'
          ? 'Pull to reconnect'
          : ''

  const visible = state.phase !== 'idle'
  const translate =
    state.phase === 'cooldown'
      ? PTR_THRESHOLD * 0.5
      : ptrIndicatorTranslate(state.deltaY)

  return (
    <div
      aria-hidden={!visible}
      className="mono"
      style={{
        position: 'absolute',
        top: 'calc(52px + env(safe-area-inset-top, 0px))',
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 25,
        transform: `translateY(${visible ? translate - 32 : -32}px)`,
        transition:
          state.phase === 'pulling' || state.phase === 'committed'
            ? 'none'
            : 'transform 180ms ease-out',
      }}
    >
      <div
        style={{
          padding: '6px 12px',
          background: 'var(--surface)',
          border: '1.5px solid var(--line)',
          borderRadius: 999,
          fontSize: 10,
          letterSpacing: '0.1em',
          color: 'var(--ink)',
          textTransform: 'uppercase',
          boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
          opacity: visible ? 1 : 0,
        }}
      >
        {label || 'Pull to reconnect'}
      </div>
    </div>
  )
}
