// Reload-to-update flow for the SPA service workers (epic #675).
//
// The SWs used to call `self.skipWaiting()` at install, which swaps the
// new bundle in under a *running* session — a lazy-loaded chunk fetched
// after the swap can belong to a different build than the shell that
// requested it. The replacement flow:
//
//   1. sw.ts drops the blind skipWaiting() and instead installs
//      `swSkipWaitingListener` (see ./sw-listener.ts, imported by the
//      SW bundle) so the new worker waits until told.
//   2. The app shell mounts `useSwUpdatePrompt()`. When a new worker
//      reaches `waiting`, `updateReady` flips true and the app shows
//      its "New version available — Reload" toast/banner.
//   3. Accepting calls `applyUpdate()`: the waiting worker gets
//      SKIP_WAITING, takes control (`clientsClaim()` is still on), and
//      the one-shot controllerchange listener reloads the page.
//
// vite-plugin-pwa's `injectRegister: 'auto'` still performs the
// registration itself; this module only observes it.

import { useEffect, useState } from 'react'

export const SKIP_WAITING_MESSAGE = { type: 'SKIP_WAITING' } as const

/**
 * Observe the app's SW registration for an update sitting in `waiting`.
 * Calls `onReady(apply)` (at most once per waiting worker); `apply()`
 * tells that worker to activate and reloads the page when it takes
 * control. Returns a cleanup function.
 */
export function watchSwUpdates(onReady: (apply: () => void) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {}
  }
  let disposed = false
  let reloading = false
  const cleanups: (() => void)[] = []

  const onControllerChange = (): void => {
    // Reload exactly once, and only after an explicit applyUpdate() —
    // never on the first controller claim of a fresh install.
    if (reloading) return
    reloading = true
    window.location.reload()
  }

  const surface = (reg: ServiceWorkerRegistration): void => {
    if (disposed || !reg.waiting) return
    const waiting = reg.waiting
    onReady(() => {
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
      cleanups.push(() =>
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange),
      )
      waiting.postMessage(SKIP_WAITING_MESSAGE)
    })
  }

  void navigator.serviceWorker.ready.then((reg) => {
    if (disposed) return
    // An update may already be parked from a previous visit.
    surface(reg)
    const onUpdateFound = (): void => {
      const installing = reg.installing
      if (!installing) return
      const onStateChange = (): void => {
        // `installed` + an existing controller ⇒ this is an update, not
        // the first install.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          surface(reg)
        }
      }
      installing.addEventListener('statechange', onStateChange)
      cleanups.push(() => installing.removeEventListener('statechange', onStateChange))
    }
    reg.addEventListener('updatefound', onUpdateFound)
    cleanups.push(() => reg.removeEventListener('updatefound', onUpdateFound))

    // The browser only checks for a new SW on navigation, so a
    // long-lived tab (installed PWA left open) would never see the
    // banner. Re-check whenever the tab regains visibility.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        reg.update().catch(() => {}) // offline/transient failures are fine
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisible))
  })

  return () => {
    disposed = true
    for (const fn of cleanups.splice(0)) fn()
  }
}

export interface SwUpdatePromptState {
  /** True when a new build is parked in `waiting`. */
  updateReady: boolean
  /** Activate the waiting worker and reload. No-op until updateReady. */
  applyUpdate: () => void
}

/**
 * App-shell hook: `updateReady` flips true when a new version is
 * waiting; render your toast/banner and call `applyUpdate()` on accept.
 */
export function useSwUpdatePrompt(): SwUpdatePromptState {
  const [apply, setApply] = useState<(() => void) | null>(null)
  useEffect(() => watchSwUpdates((fn) => setApply(() => fn)), [])
  return {
    updateReady: apply !== null,
    applyUpdate: apply ?? (() => {}),
  }
}
