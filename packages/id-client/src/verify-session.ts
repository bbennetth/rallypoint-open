import type { UserInfo } from './types.js'

// verifySession — the SDK's primary surface for server-side
// consumers. Calls POST /api/v1/sdk/session/verify on the RPI API
// with the supplied bearer token; returns the OIDC-shape UserInfo
// on success, null on 401, throws on transport/5xx errors.
//
// Includes a small in-process cache so a Pages Function / Lambda
// that fans out many requests with the same bearer pays for the
// upstream call only once per ttlMs.

export interface VerifySessionOptions {
  apiBase: string // e.g. https://id.rallypt.app
  fetchImpl?: typeof fetch
  cacheTtlMs?: number // default 30_000
  cacheCapacity?: number // default 1000
}

export interface VerifySessionResult {
  ok: true
  user: UserInfo
}

export interface VerifySessionFailure {
  ok: false
  reason: 'invalid' | 'transport_error'
}

interface CacheEntry {
  insertedAtMs: number
  result: VerifySessionResult | VerifySessionFailure
}

// We hash the token before using it as a cache key so a heap dump
// doesn't leak the bearer. The hash is a stable opaque key, never
// sent to the server.
async function hashKey(token: string): Promise<string> {
  // crypto.subtle is available on every supported runtime (Node 20+,
  // browsers, Workers, Bun, Deno). Fall back to the bare token if
  // the runtime omits it (which would be a Node < 20 install — and
  // our peer engines block that anyway).
  if (typeof crypto?.subtle?.digest !== 'function') return token
  const bytes = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export class SessionVerifier {
  private readonly fetchImpl: typeof fetch
  private readonly apiBase: string
  private readonly cacheTtlMs: number
  private readonly cacheCapacity: number
  private readonly cache = new Map<string, CacheEntry>()

  constructor(opts: VerifySessionOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000
    this.cacheCapacity = opts.cacheCapacity ?? 1000
  }

  async verifySession(token: string): Promise<VerifySessionResult | VerifySessionFailure> {
    if (!token) return { ok: false, reason: 'invalid' }
    const key = await hashKey(token)
    const cached = this.cache.get(key)
    const now = Date.now()
    if (cached && now - cached.insertedAtMs < this.cacheTtlMs) {
      // Refresh LRU position.
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached.result
    }
    let result: VerifySessionResult | VerifySessionFailure
    try {
      const res = await this.fetchImpl(`${this.apiBase}/api/v1/sdk/session/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (res.status === 200) {
        const user = (await res.json()) as UserInfo
        result = { ok: true, user }
      } else if (res.status === 401) {
        result = { ok: false, reason: 'invalid' }
      } else {
        // 5xx / unexpected — surface as transport_error without
        // caching, so the next call retries.
        return { ok: false, reason: 'transport_error' }
      }
    } catch {
      return { ok: false, reason: 'transport_error' }
    }

    this.cache.set(key, { insertedAtMs: now, result })
    if (this.cache.size > this.cacheCapacity) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    return result
  }

  invalidate(token: string): void {
    // Synchronous best-effort — recompute the key.
    // Note: caller can also just let the entry age out.
    void hashKey(token).then((key) => this.cache.delete(key))
  }

  invalidateAll(): void {
    this.cache.clear()
  }
}

// Convenience function for one-off callers that don't need to hold
// onto a cached verifier instance. Recommended for short-lived
// serverless invocations; for long-lived processes, construct a
// SessionVerifier and reuse it.
export async function verifySessionOnce(
  token: string,
  opts: VerifySessionOptions,
): Promise<VerifySessionResult | VerifySessionFailure> {
  return new SessionVerifier(opts).verifySession(token)
}
