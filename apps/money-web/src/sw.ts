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
// (e.g. downloads) reach the Worker instead of being served the SPA shell.
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
