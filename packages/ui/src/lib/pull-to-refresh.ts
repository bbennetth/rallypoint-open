// Pure decision math behind the mobile pull-to-refresh gesture. The
// companion component (`<PullToRefresh>`) wires touch events to these
// helpers — keeping the math here means the threshold/damping rules
// are unit-testable without RTL.
//
// Ported from festival-planner/src/lib/pullToRefresh.ts during the
// migration to bring rallypoint up to visual parity.

export const PTR_THRESHOLD = 80
export const PTR_ACTIVATION_SLOP = 24
export const PTR_DAMPING = 0.5
export const PTR_MAX_TRANSLATE = 120

export type PtrPhase = 'idle' | 'pulling' | 'committed' | 'cooldown'

export interface PtrState {
  phase: PtrPhase
  // Raw vertical pull distance in CSS pixels (touchY - startY).
  deltaY: number
  // The clientY captured at touchstart, or null if we never armed.
  startY: number | null
}

export const PTR_IDLE: PtrState = { phase: 'idle', deltaY: 0, startY: null }

// touchstart. We only arm the gesture when the scroll container is
// already at the top — otherwise the user is mid-scroll and we should
// stay out of their way.
export function ptrOnStart(scrollTop: number, touchY: number): PtrState {
  if (scrollTop > 0) return PTR_IDLE
  return { phase: 'idle', deltaY: 0, startY: touchY }
}

// touchmove. Activates `pulling` once the user has dragged downward
// past a small slop distance. Tiny downward motion at the top should
// stay idle so normal scroll intent gets first chance. An upward drag
// — or any movement while the scroller is no longer at the top — drops
// us back to idle so the native scroll takes over. Once `cooldown` is
// set we ignore further movement until the consumer flips us out.
export function ptrOnMove(
  state: PtrState,
  scrollTop: number,
  touchY: number,
): PtrState {
  if (state.phase === 'cooldown') return state
  if (state.startY == null) return state
  if (scrollTop > 0) return PTR_IDLE
  const deltaY = touchY - state.startY
  if (deltaY <= 0) return { phase: 'idle', deltaY: 0, startY: state.startY }
  if (deltaY < PTR_ACTIVATION_SLOP) {
    return { phase: 'idle', deltaY: 0, startY: state.startY }
  }
  const phase: PtrPhase = deltaY >= PTR_THRESHOLD ? 'committed' : 'pulling'
  return { phase, deltaY, startY: state.startY }
}

// touchend / touchcancel. Returns whether the gesture should fire its
// onRefresh callback (only when phase reached `committed`) plus the
// next state — `cooldown` on commit so a rapid second pull can't
// re-fire while reconnect is in flight, otherwise `idle`.
export function ptrOnEnd(state: PtrState): {
  commit: boolean
  next: PtrState
} {
  if (state.phase === 'cooldown') {
    return { commit: false, next: state }
  }
  if (state.phase === 'committed') {
    return {
      commit: true,
      next: { phase: 'cooldown', deltaY: 0, startY: null },
    }
  }
  return { commit: false, next: PTR_IDLE }
}

// The pixel translate to apply to the indicator while pulling. Damped
// so the user has to drag noticeably further than the indicator
// travels, and clamped so a violent pull doesn't shoot it off-screen.
export function ptrIndicatorTranslate(deltaY: number): number {
  if (deltaY <= 0) return 0
  return Math.min(PTR_MAX_TRANSLATE, deltaY * PTR_DAMPING)
}

// Pull-to-refresh should report success only after the reconnect cycle
// has actually gone unsynced and then received a fresh welcome frame.
export function ptrSyncCycleStatus(
  sawUnsynced: boolean,
  synced: boolean,
): {
  sawUnsynced: boolean
  complete: boolean
} {
  if (!synced) return { sawUnsynced: true, complete: false }
  if (sawUnsynced) return { sawUnsynced: false, complete: true }
  return { sawUnsynced, complete: false }
}
