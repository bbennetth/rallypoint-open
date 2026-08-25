// Rest-timer alert logic. The PURE decision functions live here (unit-
// tested); the side-effecting sound/notification triggers stay in the
// page effect that watches restRemainingS.
//
// Contract: alerts key off NATURAL one-second decrements of the rest
// countdown (prev → prev-1, driven by the TICK loop). A skip (→ null)
// or a ±15/±30 adjust (jump ≠ -1) never matches the predicate, which
// is exactly the requested "if skipped, don't play sound" behavior —
// no special-casing needed.

export type RestAlertsMode = 'off' | 'sound' | 'notify'

export const REST_ALERTS_MODES: readonly RestAlertsMode[] = ['off', 'sound', 'notify']

/** Narrow unknown input to a mode; unrecognized falls back to 'sound'
 *  (the beeps are the core ask; notifications stay opt-in). */
export function sanitizeRestAlertsMode(value: unknown): RestAlertsMode {
  return value === 'off' || value === 'notify' ? value : 'sound'
}

/** The 5-4-3-2-1 countdown: returns the second to beep for when a
 *  natural decrement lands in the final-five window, else null. */
export function countdownBeepSecond(
  prev: number | null,
  next: number | null,
): number | null {
  if (prev == null || next == null) return null
  if (next !== prev - 1) return null
  return next >= 1 && next <= 5 ? next : null
}

/** The "go" moment: a natural tick from 1 to 0. A skip from any other
 *  remaining value goes straight to null and never matches. */
export function isNaturalRestFinish(prev: number | null, next: number | null): boolean {
  return prev === 1 && next === 0
}

// ── End-of-rest timer + fire-time decisions ─────────────────────────
// The end-of-rest alert is driven by ONE absolute-deadline setTimeout
// per rest period, not by the (browser-throttled) 1 s TICK interval.
// The page re-projects the deadline on every countdown change;
// shouldRearmRestTimer decides whether that projection means "same
// rest period, natural drift — keep the armed timer" or "the rest was
// started/adjusted/resumed — re-arm".

/** Natural ticking re-projects the same deadline (± scheduling jitter);
 *  a start / ±15 / ±30 / resume moves it by whole seconds. */
export const REST_REARM_TOLERANCE_MS = 1500

/** What the page armed the end-of-rest timer (and server push) with. */
export interface ArmedRestTimer {
  deadlineMs: number
  nextUp: string
}

export function shouldRearmRestTimer(
  armed: ArmedRestTimer | null,
  projectedDeadlineMs: number,
  nextUp: string,
  toleranceMs: number = REST_REARM_TOLERANCE_MS,
): boolean {
  if (armed == null) return true
  // A changed next-up label means a DIFFERENT rest period even when the
  // deadline barely moved: two COMPLETE_SETs within the tolerance window
  // (batch-checking the last two sets of an exercise) project near-equal
  // deadlines, and the deadline-only guard used to keep the first tap's
  // stale label armed — the notification then named the set just done
  // instead of the next exercise.
  if (armed.nextUp !== nextUp) return true
  return Math.abs(projectedDeadlineMs - armed.deadlineMs) > toleranceMs
}

export type NotificationPermissionState = 'default' | 'denied' | 'granted' | 'unsupported'

export type RestFireAction = 'notify' | 'sound' | 'none'

/** What to do the moment rest hits zero. A hidden tab with granted
 *  permission gets the local notification; every other combination
 *  falls back to the go tone (never silently nothing — the old
 *  hidden-only gate dropped the alert when the user refocused the tab
 *  right as the timer fired). */
export function restFireAction(
  visibility: 'visible' | 'hidden',
  permission: NotificationPermissionState,
  mode: RestAlertsMode,
): RestFireAction {
  if (mode === 'off') return 'none'
  if (visibility === 'hidden' && mode === 'notify' && permission === 'granted') return 'notify'
  return 'sound'
}

/** 'notify' is only honest while browser permission is still granted.
 *  Permission can be revoked out-of-band (browser settings, iOS app
 *  toggles, site-data reset to 'default') — downgrade the persisted
 *  mode to 'sound' instead of silently no-oping every alert. */
export function downgradedAlertsMode(
  mode: RestAlertsMode,
  permission: NotificationPermissionState,
): RestAlertsMode {
  return mode === 'notify' && permission !== 'granted' ? 'sound' : mode
}

/** Two finish signals closer together than this are one rest period
 *  double-reported, not two rests — no real rest is this short. Its
 *  own tunable, distinct from the re-arm tolerance above. */
export const REST_FINISH_DEDUP_MS = 1500

/** Dedup guard: the natural 1→0 tick and the absolute-deadline timeout
 *  both signal the finish and can land within milliseconds of each
 *  other — only the first one within the gap window wins. */
export function shouldSignalRestFinish(
  lastSignalMs: number,
  nowMs: number,
  minGapMs: number = REST_FINISH_DEDUP_MS,
): boolean {
  return nowMs - lastSignalMs >= minGapMs
}
