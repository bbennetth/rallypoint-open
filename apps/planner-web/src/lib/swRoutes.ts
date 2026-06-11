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
