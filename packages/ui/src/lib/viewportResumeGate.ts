/**
 * Pure gate for resume-rehydrate of `--app-vh` / `--keyboard-inset`.
 *
 * `useViewportHeight` re-reads viewport metrics when the page leaves
 * and returns (`visibilitychange`, `pagehide`/`pageshow`, `blur`/
 * `focus`) so the bottom TabBar doesn't float mid-screen when the user
 * backgrounds the app with a keyboard up, rotates the device, or
 * otherwise changes viewport while the page is suspended.
 *
 * The rules live here so they're testable without `document` /
 * `window` / React. The hook owns the side-effecting listeners and the
 * mutable `resumeState`; this helper owns the policy.
 */

export interface ViewportResumeGateState {
  /** True after an away signal; cleared on the next resume signal
   *  whether or not we fire. */
  wasAway: boolean
}

export type ViewportResumeSource =
  | { kind: 'visibility'; hidden: boolean }
  | { kind: 'pagehide' }
  | { kind: 'blur' }
  | { kind: 'focus' }
  | { kind: 'pageshow-persisted' }

/** Apply one event to the gate; returns whether the hook should re-read
 *  viewport metrics AND the next gate state. The hook overwrites its
 *  mutable state with `next` regardless of `fire`. */
export function shouldFireViewportResume(
  state: ViewportResumeGateState,
  source: ViewportResumeSource,
): { fire: boolean; next: ViewportResumeGateState } {
  if (source.kind === 'visibility') {
    if (source.hidden) {
      return { fire: false, next: { wasAway: true } }
    }
    if (!state.wasAway) return { fire: false, next: state }
    return { fire: true, next: { wasAway: false } }
  }
  if (source.kind === 'pagehide' || source.kind === 'blur') {
    return { fire: false, next: { wasAway: true } }
  }
  if (source.kind === 'focus') {
    if (!state.wasAway) return { fire: false, next: state }
    return { fire: true, next: { wasAway: false } }
  }
  // pageshow-persisted: independent of `wasAway` because iOS may
  // suspend into bfcache without firing a prior away signal.
  return { fire: true, next: { wasAway: false } }
}
