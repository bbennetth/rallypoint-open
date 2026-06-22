/// <reference lib="webworker" />
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { clientsClaim } from 'workbox-core'
import { isCacheableImage, NAVIGATION_DENYLIST } from './lib/swRoutes.js'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[]
}

self.skipWaiting()
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
  event.waitUntil(self.registration.showNotification(payload.title ?? 'Rallypoint', options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data as { url?: string } | undefined
  const url = data?.url ?? '/'
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
