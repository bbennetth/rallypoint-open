/** Detect whether the app is running as an installed PWA (standalone
 *  display mode). Used by `useViewportHeight` to gate the iOS
 *  cold-launch `--app-vh` defence and by main.tsx to set the
 *  `data-pwa-standalone` attribute that the theme's tab-bar rules read.
 *
 *  Wrapped in try/catch because some embedded WebViews throw on the
 *  unknown `(display-mode: standalone)` media query. */
export function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) return true
    } catch {
      // Fall through to the legacy iOS check.
    }
  }
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { standalone?: boolean })
      : null
  return nav?.standalone === true
}
