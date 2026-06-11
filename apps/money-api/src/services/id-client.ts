import { SessionVerifier, signoutSession } from '@rallypoint/id-client'
import type { IdClientService } from './types.js'

// Wraps the @rallypoint/id-client SessionVerifier. A single verifier
// instance is constructed once and reused so its 30s in-process cache
// actually does its job.

export function createIdClientService(opts: {
  apiBase: string
  // Optional fetch override — a Cloudflare service-binding fetcher when one
  // is bound (RPID), else the global fetch. Dispatches the RPID hop
  // in-process instead of through the public edge (which drops same-account
  // loopback fetches).
  fetchImpl?: typeof fetch | undefined
}): IdClientService {
  // Spread the override in only when present so the SDK's `fetchImpl?` (no
  // explicit `| undefined`) isn't handed an undefined under
  // exactOptionalPropertyTypes; absent → SDK uses the global fetch.
  const fetchOpt = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}
  const verifier = new SessionVerifier({
    apiBase: opts.apiBase,
    cacheTtlMs: 30_000,
    ...fetchOpt,
  })
  return {
    async verifyRpidBearer(bearer) {
      const res = await verifier.verifySession(bearer)
      if (res.ok) return { ok: true, userId: res.user.sub }
      if (res.reason === 'invalid') return { ok: false, revoked: true }
      // transport_error — RPID hiccup, not a revocation. Throw so the
      // session middleware can return 503 and keep the row.
      throw new Error('rpid_transport_error')
    },
    async signoutRpidBearer(bearer) {
      const res = await signoutSession(bearer, { apiBase: opts.apiBase, ...fetchOpt })
      if (!res.ok) throw new Error('rpid_transport_error')
    },
  }
}
