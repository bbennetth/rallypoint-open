// Pure URL-matching predicate for the service worker (`../sw.ts`).
// Kept in its own module so it's unit-testable without a Workbox
// runtime (sw.ts imports Workbox internals that don't load under
// vitest's node environment). MUST stay pure — no `self.*`, no globals.

// We deliberately cache NO `GET /api/*` responses. Nearly every BFF
// read is session-scoped (e.g. `/api/v1/ui/events` →
// `listForUser(userId)`), and a URL-keyed runtime cache has no
// `Vary: Authorization`, so a cached 200 would replay one user's data
// to the next on a shared installed PWA (offline or during a network
// timeout). API reads therefore go straight to the network — there is
// no Workbox route for them, so the browser's default fetch applies
// (NetworkOnly). All `/api/*` is network-only regardless of transport,
// which also keeps the realtime WebSocket upgrade
// (`/api/v1/ui/realtime`) uncached — required, since caching a
// long-lived connection would buffer/hang it.
//
// Image route gate: cache same-origin *static* images (brand icons and
// other bundled/asset images) CacheFirst for offline paint. Excludes
// `/api/*` images, which can be private user-scoped uploads (e.g. event
// map images) and would carry the same cross-user replay risk.
export function isCacheableImage(destination: string, pathname: string): boolean {
  return destination === 'image' && !pathname.startsWith('/api/')
}
