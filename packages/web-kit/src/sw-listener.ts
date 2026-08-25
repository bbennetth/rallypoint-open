// Service-worker-side half of the reload-to-update flow (import from
// '@rallypoint/web-kit/sw' — this module must stay free of React/DOM
// imports so it's safe in the SW bundle). See ./sw-update.ts for the
// page-side hook and the overall design.

/// <reference lib="webworker" />

/**
 * Replaces the old blind `self.skipWaiting()`: the new worker waits in
 * `waiting` until the page (via `applyUpdate()`) posts SKIP_WAITING.
 */
export function swSkipWaitingListener(scope: ServiceWorkerGlobalScope): void {
  scope.addEventListener('message', (event) => {
    const data: unknown = event.data
    if (
      typeof data === 'object' &&
      data !== null &&
      (data as { type?: unknown }).type === 'SKIP_WAITING'
    ) {
      void scope.skipWaiting()
    }
  })
}
