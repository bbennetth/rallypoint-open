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
import { swPushSubscriptionChangeListener } from '@rallypoint/web-kit/sw-push'
import { isCacheableImage, restPushShowOptions } from './lib/swRoutes.js'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[]
}

// Reload-to-update flow (#675): the new worker waits in `waiting` until
// the app shell's useSwUpdatePrompt() → applyUpdate() posts SKIP_WAITING,
// instead of blindly swapping the bundle under a running session.
swSkipWaitingListener(self)

// The push service rotated or invalidated our subscription: re-subscribe
// and hand the new endpoint to fitness-api. Chrome/FCM fires this
// reliably; WebKit rarely does, which is why the page-side heal
// (usePushSync in AppChrome) exists too.
swPushSubscriptionChangeListener(self)
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

// Server-sent rest-timer push (fitness-api DO alarm / cron sweep). If
// THIS rest period's local banner is already visible — matched on the
// deadline the payload carries, since the page stamps the same value on
// its local notification — the page delivered the alert and its disarm
// lost the race: show a SILENT same-tag replacement (one banner, no
// second alert) rather than trusting near-simultaneous OS tag
// collapsing, and rather than skipping — a push that shows nothing
// burns the origin's silent-push budget (Chrome) and risks subscription
// revocation on WebKit. Any pre-check failure fails open to a normal
// show.
self.addEventListener('push', (event) => {
  let payload: {
    title?: string
    body?: string
    url?: string
    tag?: string
    deadlineMs?: number
  } = {}
  try {
    payload = (event.data?.json() ?? {}) as typeof payload
  } catch {
    /* malformed payload — fall through to the generic banner */
  }
  const tag = payload.tag ?? 'rp-rest-timer'
  event.waitUntil(
    (async () => {
      let existingDeadlines: unknown[] = []
      try {
        const existing = await self.registration.getNotifications({ tag })
        existingDeadlines = existing.map(
          (n) => (n.data as { deadlineMs?: unknown } | null)?.deadlineMs,
        )
      } catch {
        /* pre-check failure must not eat the alert — show it normally */
      }
      const opts = restPushShowOptions(payload.deadlineMs, existingDeadlines)
      // A duplicate re-paints this rest's own banner in place: silent,
      // and a same-tag replace doesn't re-alert (renotify defaults
      // false) — per spec and on Chrome. WebKit's tag → notification
      // identifier mapping is less documented; if iOS still re-alerts
      // here it needs an on-device check, not another silent knob. The
      // re-paint may also swap in the server's (schedule-time) body
      // text for the page's fire-time label — acceptably close.
      await self.registration.showNotification(payload.title ?? 'Rest done', {
        body: payload.body ?? 'Back to work.',
        tag,
        icon: '/icons/icon-192.png',
        silent: opts.silent,
        data: opts.data,
      })
    })(),
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
