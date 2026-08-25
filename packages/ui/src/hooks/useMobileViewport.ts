import { useSyncExternalStore } from 'react'
import { MOBILE_VIEWPORT_QUERY, isMobileViewport } from '../lib/breakpoints.js'

// Reactive "is this a mobile viewport?" for behavior that branches in JS
// rather than CSS — e.g. picking a different route destination for a
// link. Styling should still use a media query; reach for this only when
// the decision can't be expressed in CSS.
//
// `useSyncExternalStore` over the MediaQueryList's own `change` event
// (rather than a resize listener) means React re-renders exactly once,
// when the breakpoint is actually crossed. Same pattern as planner-web's
// `useTabOrder`.

function subscribe(onChange: () => void): () => void {
  const mql =
    typeof window === 'undefined' ? undefined : window.matchMedia?.(MOBILE_VIEWPORT_QUERY)
  if (!mql) return () => {}
  mql.addEventListener('change', onChange)
  return () => {
    mql.removeEventListener('change', onChange)
  }
}

function getSnapshot(): boolean {
  return typeof window === 'undefined' ? false : isMobileViewport(window)
}

// No SSR in this stack, but useSyncExternalStore requires the third arg
// for any server/prerender pass. Desktop is the safe default — it's the
// behavior every consumer had before this hook existed.
function getServerSnapshot(): boolean {
  return false
}

/** True while the viewport is mobile-width; re-renders on breakpoint
 * crossings (rotate, resize, desktop window drag). */
export function useMobileViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
