// Pure URL-matching predicate for the service worker (`../sw.ts`).
// Kept in its own module so it's unit-testable without a Workbox
// runtime. MUST stay pure — no `self.*`, no globals.

export function isCacheableImage(destination: string, pathname: string): boolean {
  return destination === 'image' && !pathname.startsWith('/api/')
}
