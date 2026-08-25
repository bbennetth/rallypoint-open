/// <reference lib="webworker" />
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { clientsClaim } from 'workbox-core'
import { swSkipWaitingListener } from '@rallypoint/web-kit/sw'
import { isCacheableImage } from './lib/swRoutes.js'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[]
}

// Reload-to-update flow (#675): the new worker waits in `waiting` until
// the app shell's useSwUpdatePrompt() → applyUpdate() posts SKIP_WAITING,
// instead of blindly swapping the bundle under a running session.
swSkipWaitingListener(self)
clientsClaim()
cleanupOutdatedCaches()

precacheAndRoute(self.__WB_MANIFEST)

// SPA navigation fallback. /api/* is excluded so backend navigations
// reach the Worker instead of being served the SPA shell.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//],
  }),
)

// Same-origin static images — CacheFirst.
registerRoute(
  ({ url, request, sameOrigin }) =>
    sameOrigin && isCacheableImage(request.destination, url.pathname),
  new CacheFirst({ cacheName: 'image-cache' }),
)

// zxing-wasm reader binary (issue #702) — CacheFirst. Kept OUT of the
// precache manifest (globPatterns excludes .wasm) so the ~1 MB binary
// isn't forced on every user; Chrome/Android decode natively and never
// fetch it. iOS Safari and the live scanner fetch it on first scan; the
// hashed filename is immutable, so CacheFirst makes offline re-scans work.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname.endsWith('.wasm'),
  new CacheFirst({ cacheName: 'wasm-cache' }),
)

// Server-sent rest-timer push (fitness-api DO alarm / cron sweep): show
// the notification with the payload's tag so it COLLAPSES with any local
// notification the page fired for the same rest period — one banner, not
// two, whichever alert lands first.
self.addEventListener('push', (event) => {
  let payload: { title?: string; body?: string; url?: string; tag?: string } = {}
  try {
    payload = (event.data?.json() ?? {}) as typeof payload
  } catch {
    /* malformed payload — fall through to the generic banner */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'Rest done', {
      body: payload.body ?? 'Back to work.',
      tag: payload.tag ?? 'rp-rest-timer',
      icon: '/icons/icon-192.png',
    }),
  )
})

// Rest-timer local notifications (the page shows these via
// registration.showNotification when a rest ends in a hidden tab).
// Clicking one focuses the running session — or opens a window when
// the tab was closed.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => 'focus' in c)
      if (existing) return existing.focus()
      return self.clients.openWindow('/live/strength/new')
    }),
  )
})
