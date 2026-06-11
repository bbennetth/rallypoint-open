import { useEffect, useLayoutEffect } from 'react'
import { detectStandalone } from '../lib/standalone.js'
import {
  shouldFireViewportResume,
  type ViewportResumeGateState,
} from '../lib/viewportResumeGate.js'

// `useLayoutEffect` runs synchronously after DOM mutations but before
// the browser paints — so `--app-vh` is set before first paint, avoiding
// the brief `100dvh` fallback flash on iOS PWA cold-launch. `useEffect`
// on SSR-only paths to keep React's no-op warning quiet.
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * Pick the layout-friendly viewport height from `visualViewport` and
 * `window.innerHeight`. Pure helper so the decision is unit-testable
 * without a DOM.
 *
 * - `visualViewport.height` reflects the actual visible area — URL bar
 *   and on-screen keyboard accounted for. Live truth on iOS Safari /
 *   Android Chrome.
 * - `window.innerHeight` reflects the layout viewport — doesn't shrink
 *   on pinch-zoom or on iOS/WKWebView keyboard reveal.
 * - `visualViewport.scale` is `1` when the page isn't pinch-zoomed.
 *
 * Rules: (1) when pinch-zoomed, prefer `innerHeight` so the shell
 * doesn't reflow mid-gesture; (2) otherwise prefer
 * `visualViewport.height` (the URL-bar / keyboard-reveal case);
 * (3) fall back to `innerHeight` when visualViewport is unavailable or
 * reports 0.
 */
export function pickViewportHeight(
  visualViewportHeight: number | null | undefined,
  windowInnerHeight: number,
  visualViewportScale?: number | null,
): number {
  const visual = Math.max(0, visualViewportHeight ?? 0)
  const layout = Math.max(0, windowInnerHeight)
  const scale = visualViewportScale ?? 1
  const isZoomed = Math.abs(scale - 1) > 0.01

  if (isZoomed) return layout
  return visual > 0 ? visual : layout
}

/**
 * Soft-keyboard inset picker. Standalone PWA layout anchors the TabBar
 * via `position: fixed; bottom: var(--keyboard-inset, 0)` and reserves
 * matching space in `.app-main`'s padding-bottom. This computes the
 * inset from the gap between `window.innerHeight` (layout viewport —
 * doesn't shrink with the keyboard on iOS Safari) and
 * `visualViewport.height` (the actual visible area — does shrink).
 *
 * Returns 0 when pinch-zoomed, when the diff is < 100px (system
 * gesture/nav bars and URL-bar collapse aren't keyboards; real soft
 * keyboards are reliably ≥ 200px), or when either input is missing.
 */
export function pickKeyboardInset(
  visualViewportHeight: number | null | undefined,
  windowInnerHeight: number,
  visualViewportScale?: number | null,
): number {
  const visual = Math.max(0, visualViewportHeight ?? 0)
  const layout = Math.max(0, windowInnerHeight)
  const scale = visualViewportScale ?? 1
  const isZoomed = Math.abs(scale - 1) > 0.01
  if (isZoomed) return 0
  if (visual <= 0 || layout <= 0) return 0
  const diff = layout - visual
  if (diff < 100) return 0
  return diff
}

/**
 * Cold-launch picker for `--app-vh`. In iOS Safari standalone PWA mode
 * `visualViewport.height` can be stale-low (short by the home-indicator
 * inset) for the entire pre-interaction window, while `innerHeight` is
 * reliable on cold-launch. So prefer the LARGER of the two until a live
 * `visualViewport.resize` lets us switch to `pickViewportHeight`.
 * Pinch-zoom still falls back to `innerHeight` (the larger when zoomed
 * in), so `Math.max` preserves that.
 */
export function pickInitialViewportHeight(
  visualViewportHeight: number | null | undefined,
  windowInnerHeight: number,
  visualViewportScale?: number | null,
): number {
  const visual = Math.max(0, visualViewportHeight ?? 0)
  const layout = Math.max(0, windowInnerHeight)
  const scale = visualViewportScale ?? 1
  const isZoomed = Math.abs(scale - 1) > 0.01
  if (isZoomed) return layout
  return Math.max(visual, layout)
}

/** Delays (ms) for deferred `--app-vh` recomputes after mount, to catch
 *  the iOS PWA cold-launch settle window. */
export function getViewportRecomputeDelays(): readonly number[] {
  return [120, 480, 1000]
}

/** Delays (ms) for viewport re-reads after foreground resume or mobile
 *  editable focus changes. */
export function getViewportResumeRecomputeDelays(): readonly number[] {
  return [120, 500]
}

const EDITABLE_INPUT_TYPES = new Set([
  'text',
  'email',
  'password',
  'search',
  'tel',
  'url',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
])

interface ViewportFocusTarget {
  tagName?: string
  type?: string
  isContentEditable?: boolean
  closest?: (selector: string) => Element | null
}

function isEditableViewportTarget(target: EventTarget | null): boolean {
  const el = target as ViewportFocusTarget | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') {
    const type = (el.type ?? 'text').toLowerCase()
    return EDITABLE_INPUT_TYPES.has(type)
  }
  if (el.isContentEditable === true) return true
  return typeof el.closest === 'function'
    ? el.closest('[contenteditable=""], [contenteditable="true"]') !== null
    : false
}

/**
 * Cold-launch scroll-wakeup helper. The user's first scroll on
 * `.app-main` snaps the TabBar flush — so whatever iOS does in response
 * is what unsticks the stale `visualViewport`/`innerHeight` readings.
 * Mimic the gesture programmatically: append a hidden 9999px trigger so
 * the container is scrollable regardless of content, set `scrollTop = 1`,
 * force a synchronous layout flush via `offsetHeight`, revert, remove
 * the trigger. No-op when the container is missing or already scrolled.
 *
 * Pure helper, structurally — accepts any object with the DOM mutation
 * surface we need so the decision is unit-testable. Returns true if the
 * wake-up was attempted.
 */
export interface ScrollWakeupContainer {
  scrollTop: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appendChild: (node: any) => any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeChild: (node: any) => any
  offsetHeight: number
}

export interface ScrollWakeupTrigger {
  style: { cssText: string }
}

export function triggerColdLaunchScrollWakeup(
  container: ScrollWakeupContainer | null | undefined,
  createTrigger: () => ScrollWakeupTrigger = () =>
    typeof document !== 'undefined'
      ? (document.createElement('div') as unknown as ScrollWakeupTrigger)
      : ({ style: { cssText: '' } } as ScrollWakeupTrigger),
): boolean {
  if (!container) return false
  if (container.scrollTop !== 0) return false
  const trigger = createTrigger()
  trigger.style.cssText =
    'height:9999px; width:1px; visibility:hidden; pointer-events:none; flex-shrink:0;'
  container.appendChild(trigger)
  container.scrollTop = 1
  void container.offsetHeight
  container.scrollTop = 0
  container.removeChild(trigger)
  return true
}

/**
 * Track the live viewport height as a CSS custom property `--app-vh` on
 * `document.documentElement`. Used by `.app-root { height: var(--app-vh) }`
 * (in `theme.css`) to keep the layout flush with the visible viewport
 * as iOS Safari / Android Chrome reveal/hide their URL bar. Also tracks
 * `--keyboard-inset` so the standalone-PWA tab bar sits above the soft
 * keyboard. See the pure pickers above for the decision rules.
 */
export function useViewportHeight(): void {
  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') return

    // The cold-launch `Math.max` override only applies in standalone
    // PWA mode; in a regular mobile browser the URL bar is visible on
    // first paint and `visualViewport.height` is intentionally smaller
    // than `innerHeight`. Detect once at mount.
    const standalone = detectStandalone()

    // `coldLaunchActive` gates the cold-launch picker. Only flipped
    // false by `visualViewport.resize` — the iOS signal for keyboard
    // reveal / URL-bar collapse, the moment we must trust visualViewport.
    let coldLaunchActive = standalone

    const updateInitial = () => {
      if (!coldLaunchActive) return
      void document.documentElement.offsetHeight
      const h = pickInitialViewportHeight(
        window.visualViewport?.height,
        window.innerHeight,
        window.visualViewport?.scale,
      )
      if (h > 0) {
        document.documentElement.style.setProperty('--app-vh', `${h}px`)
      }
    }

    const updateLive = () => {
      const h = pickViewportHeight(
        window.visualViewport?.height,
        window.innerHeight,
        window.visualViewport?.scale,
      )
      if (h > 0) {
        document.documentElement.style.setProperty('--app-vh', `${h}px`)
      }
    }

    const updateKeyboardInset = () => {
      const inset = pickKeyboardInset(
        window.visualViewport?.height,
        window.innerHeight,
        window.visualViewport?.scale,
      )
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`)
    }

    const updateGated = () => {
      if (coldLaunchActive) updateInitial()
      else updateLive()
    }

    const onVisualViewportResize = () => {
      coldLaunchActive = false
      updateLive()
      updateKeyboardInset()
    }

    const onVisualViewportScroll = () => {
      updateInitial()
    }

    updateGated()
    updateKeyboardInset()

    const rafId =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame(updateInitial) : 0
    const timeoutIds = getViewportRecomputeDelays().map((ms) =>
      window.setTimeout(updateInitial, ms),
    )

    let scrollWakeupRafId = 0
    let postWakeupRafId = 0
    if (standalone && typeof requestAnimationFrame === 'function') {
      scrollWakeupRafId = requestAnimationFrame(() => {
        const main = document.querySelector('.app-main') as HTMLElement | null
        if (triggerColdLaunchScrollWakeup(main)) {
          postWakeupRafId = requestAnimationFrame(updateInitial)
        }
      })
    }

    let resumeState: ViewportResumeGateState = { wasAway: false }
    let resumeRehydrateRafId = 0
    let resumeRehydrateTimeoutIds: number[] = []

    const reReadLiveViewport = () => {
      updateLive()
      updateKeyboardInset()
    }

    const clearResumeRehydrateBurst = () => {
      if (resumeRehydrateRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(resumeRehydrateRafId)
      }
      resumeRehydrateRafId = 0
      resumeRehydrateTimeoutIds.forEach((id) => window.clearTimeout(id))
      resumeRehydrateTimeoutIds = []
    }

    const scheduleLiveRehydrateBurst = () => {
      clearResumeRehydrateBurst()
      reReadLiveViewport()
      if (typeof requestAnimationFrame === 'function') {
        resumeRehydrateRafId = requestAnimationFrame(() => {
          resumeRehydrateRafId = 0
          reReadLiveViewport()
        })
      }
      resumeRehydrateTimeoutIds = getViewportResumeRecomputeDelays().map((ms) =>
        window.setTimeout(reReadLiveViewport, ms),
      )
    }

    const onVisibilityChange = () => {
      const { fire, next } = shouldFireViewportResume(resumeState, {
        kind: 'visibility',
        hidden: document.hidden,
      })
      resumeState = next
      if (fire) scheduleLiveRehydrateBurst()
    }

    const onPageHide = () => {
      const { next } = shouldFireViewportResume(resumeState, { kind: 'pagehide' })
      resumeState = next
    }

    const onWindowBlur = () => {
      const { next } = shouldFireViewportResume(resumeState, { kind: 'blur' })
      resumeState = next
    }

    const onWindowFocus = () => {
      const { fire, next } = shouldFireViewportResume(resumeState, { kind: 'focus' })
      resumeState = next
      if (fire) scheduleLiveRehydrateBurst()
    }

    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      const { fire, next } = shouldFireViewportResume(resumeState, {
        kind: 'pageshow-persisted',
      })
      resumeState = next
      if (fire) scheduleLiveRehydrateBurst()
    }

    const onEditableFocusChange = (event: FocusEvent) => {
      if (isEditableViewportTarget(event.target)) scheduleLiveRehydrateBurst()
    }

    window.visualViewport?.addEventListener('resize', onVisualViewportResize)
    window.visualViewport?.addEventListener('scroll', onVisualViewportScroll)
    window.addEventListener('resize', updateGated)
    window.addEventListener('orientationchange', updateGated)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    document.addEventListener('focusin', onEditableFocusChange)
    document.addEventListener('focusout', onEditableFocusChange)
    window.addEventListener('pageshow', onPageShow)

    return () => {
      clearResumeRehydrateBurst()
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
      if (scrollWakeupRafId && typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(scrollWakeupRafId)
      if (postWakeupRafId && typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(postWakeupRafId)
      timeoutIds.forEach((id) => window.clearTimeout(id))
      window.visualViewport?.removeEventListener('resize', onVisualViewportResize)
      window.visualViewport?.removeEventListener('scroll', onVisualViewportScroll)
      window.removeEventListener('resize', updateGated)
      window.removeEventListener('orientationchange', updateGated)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      document.removeEventListener('focusin', onEditableFocusChange)
      document.removeEventListener('focusout', onEditableFocusChange)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])
}
