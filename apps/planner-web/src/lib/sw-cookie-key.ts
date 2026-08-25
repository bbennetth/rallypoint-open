// Per-user cache-key derivation for the service worker (E4 O5). The SW
// runtime-caches `/api/v1/ui/*` GET responses so an offline reload (or a
// pre-boot fetch) can replay them without a network round-trip. To avoid
// cross-user replay on a shared/installed PWA the cache name is keyed by a
// SHA-256 hash of the session cookie value — a brand-new sign-in or
// sign-out lands in a different cache and the old one is eventually
// reaped by `cleanupOutdatedCaches`.
//
// Kept in its own module so it's unit-testable without a service-worker
// runtime. MUST stay pure — no `self.*`, no globals.

const SESSION_COOKIE_CANDIDATES = ['__Host-rpp_session', 'rpp_session']

// Extract the value of the planner session cookie from a raw Cookie
// header string. Returns null when no candidate cookie is present (the
// caller should skip caching — the response would be unauthenticated).
export function extractSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  for (const candidate of SESSION_COOKIE_CANDIDATES) {
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escapeRegex(candidate)}=([^;]+)`))
    if (match?.[1]) return match[1]
  }
  return null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// SHA-256(cookieValue) → first 16 hex chars. Truncated for cache-name
// hygiene (the full 64 chars makes the IndexedDB cache-storage listing
// hard to read in DevTools); 64 bits of entropy is still well above the
// "two real users collide" threshold.
export async function deriveCacheKey(
  cookieValue: string,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  const bytes = new TextEncoder().encode(cookieValue)
  const digest = await subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return hex.slice(0, 16)
}

// Cache-name prefix shared by every per-user API cache. Used by the
// reaper that purges all old caches when the user signs out.
export const API_CACHE_PREFIX = 'planner-api-v1-'

export function cacheNameFor(userKey: string): string {
  return `${API_CACHE_PREFIX}${userKey}`
}

// Matches any cache name produced by cacheNameFor. Used by the SW to
// enumerate-and-reap old per-user caches when the active user changes.
export function isApiCacheName(name: string): boolean {
  return name.startsWith(API_CACHE_PREFIX)
}
