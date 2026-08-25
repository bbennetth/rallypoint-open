// Pure decision math behind the shared swipe-action rows (SwipeActions
// component). Touch: a leftward horizontal drag on a row reveals an action
// tray behind it. The math lives here so the intent/threshold rules are
// unit-testable without RTL — same pure-lib/component split as
// pull-to-refresh.ts.
//
// Composition with the AppChrome tab-swipe: the component marks its root
// `data-noswipe`, the same opt-out `isSwipeExcluded` (swipe-nav.ts) honors
// for the calendar grids. The mark is static — a swipe that begins on an
// actionable row should never page tabs, even before horizontal intent is
// claimed here, so there is no race between this machine and AppChrome's
// touchend classifier.

export const SA_INTENT_DISTANCE = 10
export const SA_HORIZONTAL_RATIO = 1.4 // |dx| must dominate |dy| (matches swipe-nav)
export const SA_SNAP_RATIO = 0.5 // release past this fraction of the tray width → open
export const SA_FLICK_DISTANCE = 24
export const SA_FLICK_MAX_MS = 250
export const SA_OVERDRAG = 28 // max rubber-band travel past the tray width
export const SA_OVERDRAG_DAMPING = 0.25

export type SaPhase = 'idle' | 'tracking' | 'dragging' | 'rejected' | 'open'

export interface SaState {
  phase: SaPhase
  startX: number
  startY: number
  startT: number
  // Whether the tray was open when the gesture began — the drag then starts
  // from the revealed position and a rightward drag closes it.
  openAtStart: boolean
  dx: number
}

export const SA_IDLE: SaState = {
  phase: 'idle',
  startX: 0,
  startY: 0,
  startT: 0,
  openAtStart: false,
  dx: 0,
}
export const SA_OPEN: SaState = { ...SA_IDLE, phase: 'open' }

const rest = (open: boolean): SaState => (open ? SA_OPEN : SA_IDLE)

// touchstart. Gestures only begin from a resting state (idle or open) — a
// second touch mid-gesture is ignored by returning the state unchanged.
export function saOnStart(state: SaState, x: number, y: number, t: number): SaState {
  if (state.phase !== 'idle' && state.phase !== 'open') return state
  return {
    phase: 'tracking',
    startX: x,
    startY: y,
    startT: t,
    openAtStart: state.phase === 'open',
    dx: 0,
  }
}

// touchmove. While `tracking`, neither axis has claimed the gesture yet —
// vertical scroll must win small/diagonal movements, so horizontal intent is
// only claimed once |dx| clears the slop AND dominates |dy|. A gesture the
// vertical axis claims is `rejected` for its remainder (a scroll that later
// drifts sideways must not start dragging the row).
export function saOnMove(state: SaState, x: number, y: number): SaState {
  if (state.phase === 'dragging') {
    return { ...state, dx: x - state.startX }
  }
  if (state.phase !== 'tracking') return state
  const dx = x - state.startX
  const dy = y - state.startY
  if (Math.abs(dx) >= SA_INTENT_DISTANCE && Math.abs(dx) > Math.abs(dy) * SA_HORIZONTAL_RATIO) {
    return { ...state, phase: 'dragging', dx }
  }
  if (Math.abs(dy) >= SA_INTENT_DISTANCE) {
    return { ...state, phase: 'rejected', dx }
  }
  return { ...state, dx }
}

// The translateX (px, ≤ 0) to apply to the row content. Dragging past the
// fully-open position damps and caps the excess travel (rubber band);
// rightward drag from closed clamps at the resting position.
export function saTranslate(state: SaState, trayWidth: number): number {
  if (state.phase === 'open') return -trayWidth
  const base = state.openAtStart ? -trayWidth : 0
  if (state.phase !== 'dragging') return base
  const raw = base + state.dx
  if (raw >= 0) return 0
  if (raw < -trayWidth) {
    const excess = -raw - trayWidth
    return -(trayWidth + Math.min(SA_OVERDRAG, excess * SA_OVERDRAG_DAMPING))
  }
  return raw
}

// touchend. Snap decision: past SA_SNAP_RATIO of the tray width → open. A
// fast short gesture (a flick — whole-gesture duration ≤ SA_FLICK_MAX_MS,
// the same whole-gesture heuristic swipe-nav uses) overrides position:
// leftward opens, rightward closes. A gesture that never claimed horizontal
// restores the resting state it began from — a plain tap on an open row is
// closed by the component's click swallow, not here.
export function saOnEnd(
  state: SaState,
  trayWidth: number,
  t: number,
): { open: boolean; next: SaState } {
  if (state.phase === 'dragging') {
    const flick = Math.abs(state.dx) >= SA_FLICK_DISTANCE && t - state.startT <= SA_FLICK_MAX_MS
    const open = flick
      ? state.dx < 0
      : saTranslate(state, trayWidth) <= -trayWidth * SA_SNAP_RATIO
    return { open, next: rest(open) }
  }
  if (state.phase === 'tracking' || state.phase === 'rejected') {
    return { open: state.openAtStart, next: rest(state.openAtStart) }
  }
  return { open: state.phase === 'open', next: state }
}

// touchcancel — never opens; restore the resting state the gesture began from.
export function saOnCancel(state: SaState): SaState {
  if (state.phase === 'idle' || state.phase === 'open') return state
  return rest(state.openAtStart)
}

// Whether an activation of the row content (click, or keyboard Enter/Space
// on a row-open handler) should be swallowed instead of reaching the row's
// own open handler: while the tray is open the activation closes it
// instead, and within the brief post-gesture window browsers may still
// fire a synthetic click for the touch that just dragged. `swallowUntil`
// is an event-clock timestamp set by the component at gesture end.
export function saShouldSwallowActivation(
  state: SaState,
  swallowUntil: number,
  t: number,
): boolean {
  return state.phase === 'open' || t <= swallowUntil
}

// ── One-open-at-a-time registry ──────────────────────────────────────────
// At most one row's tray is open across the app. A row registers its close
// callback when it claims a drag or opens; registering a different row's
// callback closes the previous one first. saDisarm() closes whatever is
// open — the component calls it on outside presses, scrolls and Escape.
let openRowClose: (() => void) | null = null

export function saRegisterOpen(close: () => void): void {
  if (openRowClose && openRowClose !== close) openRowClose()
  openRowClose = close
}

export function saUnregisterOpen(close: () => void): void {
  if (openRowClose === close) openRowClose = null
}

export function saDisarm(): void {
  const close = openRowClose
  openRowClose = null
  if (close) close()
}
