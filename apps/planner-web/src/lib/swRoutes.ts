// Pure URL-matching predicate for the service worker (`../sw.ts`).
// Kept in its own module so it's unit-testable without a Workbox
// runtime. MUST stay pure — no `self.*`, no globals.

// Navigation routes that must NOT be served the SPA shell — primarily
// backend API paths where `window.open` (e.g. ticket download) triggers a
// navigation request that would otherwise be intercepted and return
// index.html instead of the real Worker response.
export const NAVIGATION_DENYLIST: RegExp[] = [/^\/api\//]

export function isCacheableImage(destination: string, pathname: string): boolean {
  return destination === 'image' && !pathname.startsWith('/api/')
}

// Critical-path `/api/v1/ui/*` reads that must bypass the per-user API
// runtime cache and take the browser's default network path. The session
// probe is a liveness check on the app's boot-blocking path — routing it
// through the SW's network-first handler (caches.open + SHA-256 key +
// cache.put) let an updating SW starve it for seconds during a deploy
// rollout (skipWaiting + full precache contend for Cache Storage). It has
// its own Dexie offline fallback (api.ts getSession → readSession), and
// only JS ever fetches it, so the SW cache's pre-JS-boot rationale never
// applied — caching it here was redundant.
//
// The my-day/weather endpoint is also exempt: it carries lat/lng params whose
// cache key varies per location, so a cached response serves stale weather for
// the wrong coordinates and persists the user's precise location indefinitely
// in Cache Storage. Weather is never useful offline — if it's not fresh, show
// nothing (audit P2).
export const API_CACHE_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/ui/session',
  '/api/v1/ui/my-day/weather',
])

// Whether a request should be served by the SW per-user API runtime cache
// (`handleApiRead`). Kept pure so `../sw.ts`'s Workbox matcher stays thin
// and the exemption is unit-testable without a Workbox runtime.
export function isApiCacheableRead(method: string, pathname: string): boolean {
  return (
    method === 'GET' &&
    pathname.startsWith('/api/v1/ui/') &&
    !API_CACHE_EXEMPT_PATHS.has(pathname)
  )
}
