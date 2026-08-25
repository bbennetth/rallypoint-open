// The one place the "is this a phone-shaped viewport?" number lives.
//
// The value already drove three things independently — AppChrome's
// sidebar/tab-bar swap (shell.css), the Drawer's side-panel/bottom-sheet
// swap (DRAWER_SHEET_BREAKPOINT), and planner-web's tab-bar layout — so
// it's defined here once and re-exported rather than re-typed.
//
// `isMobileViewport` takes an injectable `Window` on purpose: jsdom ships
// no `matchMedia`, so a pure function over a fake window is the only way
// this is testable (same reason as events-web's `isStandaloneDisplay`).
// Behavior branches that need to *react* to a resize should use the
// `useMobileViewport` hook instead of calling this once at render.

/** Max viewport width (px, inclusive) treated as mobile — the width at
 * which AppChrome swaps its desktop sidebar for the mobile tab bar. */
export const MOBILE_VIEWPORT_MAX = 1023

/** Media query matching a mobile viewport. Derived from
 * `MOBILE_VIEWPORT_MAX` so the query can't drift from the constant. */
export const MOBILE_VIEWPORT_QUERY = `(max-width: ${MOBILE_VIEWPORT_MAX}px)`

/** True when the viewport is mobile-width. Falls back to `false` when
 * `matchMedia` is unavailable (jsdom, SSR) — desktop is the safer
 * default since every consumer keeps its pre-existing behavior there. */
export function isMobileViewport(win: Window = window): boolean {
  return win.matchMedia?.(MOBILE_VIEWPORT_QUERY).matches === true
}
