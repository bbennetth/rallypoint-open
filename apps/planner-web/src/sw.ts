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
import { isApiCacheableRead, isCacheableImage, NAVIGATION_DENYLIST } from './lib/swRoutes.js'
import { SW_DATA_REFRESH_MESSAGE } from './lib/sw-messages.js'
import {
  cacheNameFor,
  deriveCacheKey,
  extractSessionCookie,
  isApiCacheName,
} from './lib/sw-cookie-key.js'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[]
}

swSkipWaitingListener(self)
clientsClaim()
cleanupOutdatedCaches()

precacheAndRoute(self.__WB_MANIFEST)

// SPA navigation fallback. /api/* is excluded so backend navigations
// (e.g. ticket downloads opened with window.open) reach the Worker instead
// of being served the SPA shell.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: NAVIGATION_DENYLIST,
  }),
)

// Same-origin static images — CacheFirst.
registerRoute(
  ({ url, request, sameOrigin }) =>
    sameOrigin && isCacheableImage(request.destination, url.pathname),
  new CacheFirst({ cacheName: 'image-cache' }),
)

// --- per-user API runtime cache (E4 O5) -----------------------------
// Network-first read cache for `/api/v1/ui/*` GETs. Complements the
// Dexie cache (E4 O3) by catching the pre-JS-boot path — a direct
// refresh / share-target / window.open landing on a fetch before the
// React app has mounted still finds a cached response.
//
// Per-user isolation: cache name is keyed by SHA-256(session-cookie-value)
// so a brand-new sign-in or sign-out lands in a different cache and
// cross-user replay is impossible by construction. The prior user's
// cache is reaped by `cleanupOutdatedCaches()` (older versions) or by
// the explicit reaper below on user-switch detection.

// Track the currently-active per-user API cache name so the activate
// reaper doesn't accidentally delete it. Set on every successful
// handleApiRead so the reaper has the freshest known-good name.
let _activeApiCacheName: string | null = null

// Register as a Workbox route so the ordering vs other Workbox routes is
// explicit (matchers run in registration order) — a future catch-all
// Workbox route can't silently shadow this handler.
registerRoute(
  ({ request, url, sameOrigin }) => sameOrigin && isApiCacheableRead(request.method, url.pathname),
  ({ request }) => handleApiRead(request),
)

async function handleApiRead(req: Request): Promise<Response> {
  const cookieHeader = req.headers.get('cookie')
  const sessionCookie = extractSessionCookie(cookieHeader)
  // Unauthenticated request — don't cache anything; pass through.
  if (!sessionCookie) return fetch(req)

  const userKey = await deriveCacheKey(sessionCookie)
  const cacheName = cacheNameFor(userKey)
  _activeApiCacheName = cacheName
  const cache = await caches.open(cacheName)

  try {
    const fresh = await fetch(req)
    if (fresh.ok) {
      // Stash successful responses (200..299) for offline replay.
      await cache.put(req, fresh.clone())
      return fresh
    }
    // 5xx is a transient server fault, not a semantic signal — fall back
    // to the cached response if we have one. 4xx (401/404/etc) is a real
    // signal the UI must surface; pass it through unmodified.
    if (fresh.status >= 500) {
      const cached = await cache.match(req)
      if (cached) return cached
    }
    return fresh
  } catch (err) {
    // Transport failure (offline, DNS, server unreachable). Fall back.
    const cached = await cache.match(req)
    if (cached) return cached
    throw err
  }
}

// Reap stale per-user API caches on every activation — covers the
// sign-out-then-sign-in-as-different-user case where the SW would
// otherwise carry the old cache forever. The currently-active cache
// name (set by handleApiRead) is preserved so we never blow away the
// running user's cache.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      const apiNames = names.filter(isApiCacheName)
      const stale = apiNames.filter((n) => n !== _activeApiCacheName)
      // Best-effort delete; failures are non-fatal.
      await Promise.all(stale.map((n) => caches.delete(n).catch(() => false)))
    })(),
  )
})

// --- background sync hook (placeholder for E4 O4) -------------------
// Fires when the OS regains connectivity even if no planner-web tab is
// open. The O4 outbox engine will fully consume this; for now we just
// notify any open client to attempt a replay.
self.addEventListener('sync', (event) => {
  const syncEvent = event as ExtendableEvent & { tag: string }
  if (syncEvent.tag !== 'planner-outbox') return
  syncEvent.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window' })
      for (const client of clients) {
        client.postMessage({ type: 'planner-outbox-replay' })
      }
    })(),
  )
})

// --- Web Push (planner-owned notifications) -------------------------
// The planner-api notifications cron sends a JSON payload { title, body?, url }.
// Show it as a notification; clicking it focuses an open planner tab (or opens
// one) and navigates to the deep link.
interface PushPayload {
  title?: string
  body?: string
  url?: string
}

self.addEventListener('push', (event) => {
  let payload: PushPayload = {}
  try {
    payload = (event.data?.json() as PushPayload) ?? {}
  } catch {
    const text = event.data?.text()
    if (text) payload = { body: text }
  }
  const options: NotificationOptions = {
    icon: '/icons/rallypt-192.png',
    badge: '/icons/rallypt-192.png',
    data: { url: payload.url ?? '/' },
    ...(payload.body ? { body: payload.body } : {}),
  }
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title ?? 'Rallypoint', options),
      // A push means something changed server-side — tell open clients to
      // revalidate their cached queries so the app is fresh before the user
      // even taps the notification. Best-effort: never block the
      // notification on it.
      (async () => {
        const clients = await self.clients.matchAll({ type: 'window' })
        for (const client of clients) {
          client.postMessage({ type: SW_DATA_REFRESH_MESSAGE })
        }
      })().catch(() => undefined),
    ]),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data as { url?: string } | undefined
  const rawUrl = data?.url ?? '/'
  // Restrict to same-origin: resolve the payload URL against our origin and
  // only navigate there if it stays on the same host. A crafted push payload
  // with an external URL would otherwise silently open an arbitrary site
  // (open-redirect via the notification click). Fall back to app root on any
  // cross-origin or malformed URL (audit P2).
  let url: string
  try {
    const resolved = new URL(rawUrl, self.location.origin)
    url = resolved.origin === self.location.origin ? resolved.href : '/'
  } catch {
    url = '/'
  }
  event.waitUntil(
    (async () => {
      // Only controlled windows can be focused/navigated; if none exist (or
      // the only tab is uncontrolled, e.g. mid-SW-update) fall through to
      // openWindow so the click always lands somewhere.
      const windows = await self.clients.matchAll({ type: 'window' })
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus()
          if (url !== '/' && 'navigate' in client) {
            await client.navigate(url).catch(() => undefined)
          }
          return
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})
