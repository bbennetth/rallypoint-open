/// <reference lib="webworker" />
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'
import { clientsClaim } from 'workbox-core'
import { swSkipWaitingListener } from '@rallypoint/web-kit/sw'
import { isCacheableImage, isTemplatedNavigation } from './lib/swRoutes.js'

// `__WB_MANIFEST` is injected by vite-plugin-pwa at build time and
// isn't covered by the WebWorker lib reference — narrow `self` once.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[]
}

// Reload-to-update (epic #675): don't blindly self.skipWaiting() —
// that used to swap the new bundle in under a running session, so a
// lazy-loaded chunk fetched after the swap could belong to a
// different build than the shell that requested it. Instead the new
// worker parks in `waiting` until the page's `useSwUpdatePrompt()`
// hook (mounted in AppChrome) posts SKIP_WAITING via applyUpdate().
// clientsClaim() still runs so the newly-activated worker takes over
// immediately once it's told to.
swSkipWaitingListener(self)
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
// /e/* is excluded from the *precache* fallback: the OG-templated SPA
// shell ships from events-api per-request so crawlers + cold visits see
// correct og:* tags (and, since the per-event PWA work, the per-event
// manifest link). Serving the generic index.html here would defeat that.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/e\//, /^\/api\//],
  }),
)

// ...but /e/* still gets a NetworkFirst route of its own, registered
// after the fallback so it owns those navigations. Online it always
// hits events-api, so the templating is untouched. Offline — an
// installed event app cold-launched on a festival field with no signal
// — it serves the last-seen templated shell instead of the browser's
// offline error page. See lib/swRoutes.ts for the full reasoning.
registerRoute(
  ({ url, request, sameOrigin }) =>
    sameOrigin && request.mode === 'navigate' && isTemplatedNavigation(url.pathname),
  new NetworkFirst({ cacheName: 'public-event-pages' }),
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
