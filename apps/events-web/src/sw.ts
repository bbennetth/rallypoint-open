/// <reference lib="webworker" />
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { clientsClaim } from 'workbox-core'
import { isCacheableImage } from './lib/swRoutes.js'

// `__WB_MANIFEST` is injected by vite-plugin-pwa at build time and
// isn't covered by the WebWorker lib reference — narrow `self` once.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[]
}

// `registerType: 'autoUpdate'` (vite.config.ts): take over open clients
// on activation and drop stale precaches so a new deploy reaches
// installed users on their next launch without a manual prompt.
self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()

precacheAndRoute(self.__WB_MANIFEST)

// SPA navigation fallback. Offline, the SW intercepts navigations
// before the network is reached, so an installed cold-launch at an
// arbitrary route (e.g. /sso/callback) has no precache entry without
// this. Serve the precached index.html for navigations; the image
// route below is unaffected (`NavigationRoute` only matches
// `request.mode === 'navigate'`).
//
// /e/* is excluded from the navigation fallback (slice 11): the
// OG-templated SPA shell ships from events-api per-request so
// crawlers + cold visits see correct og:* tags. Letting the SW
// satisfy the navigation from cache would serve the generic
// index.html and defeat the templating.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/e\//, /^\/api\//],
  }),
)

// Same-origin static images — CacheFirst. `/api/*` images are excluded
// in `isCacheableImage` (cross-user replay risk). No `/api/*` data
// route is registered: all `/api/*` (GETs and the realtime WebSocket
// upgrade) goes straight to the network. See swRoutes.ts for the reasoning.
registerRoute(
  ({ url, request, sameOrigin }) =>
    sameOrigin && isCacheableImage(request.destination, url.pathname),
  new CacheFirst({ cacheName: 'image-cache' }),
)
