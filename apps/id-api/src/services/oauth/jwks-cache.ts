import type { Jwks } from '../../crypto/jwt.js'
import { OAuthProviderError } from './types.js'

// Per-isolate JWKS cache. Provider signing keys rotate slowly; a short
// TTL keeps us fresh without fetching the key set on every callback. One
// instance is shared across all providers via the factory.

interface CacheEntry {
  jwks: Jwks
  fetchedAtMs: number
}

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour

export class JwksCache {
  private readonly byUrl = new Map<string, CacheEntry>()

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(url: string): Promise<Jwks> {
    const cached = this.byUrl.get(url)
    if (cached && this.now() - cached.fetchedAtMs < this.ttlMs) return cached.jwks
    let res: Response
    try {
      res = await this.fetchImpl(url)
    } catch (err: unknown) {
      if (cached) return cached.jwks // serve stale rather than fail the login
      throw new OAuthProviderError(`JWKS fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      if (cached) return cached.jwks
      throw new OAuthProviderError(`JWKS fetch returned ${res.status}`)
    }
    const jwks = (await res.json()) as Jwks
    this.byUrl.set(url, { jwks, fetchedAtMs: this.now() })
    return jwks
  }
}
