import { batchLookupUsers, SessionVerifier, signoutSession } from '@rallypoint/id-client'
import type { IdClientService, UserBatchEntry } from './types.js'

// Wraps the @rallypoint/id-client SessionVerifier. A single verifier
// instance is constructed once and reused so its 30s in-process
// cache actually does its job (verifySessionOnce rebuilds per-call
// and never caches — do not use it here).
//
// Also exposes batchLookupUsers (Phase 0): events-api needs emails
// to render the Attendees tab; we keep the HTTP call shape opaque to
// route code by wrapping it here. apiKey is the EVENTS_API_KEY
// bearer accepted by RPID's per-app gate.

export function createIdClientService(opts: {
  apiBase: string
  apiKey: string
  // Optional fetch override — a Cloudflare service-binding fetcher when one
  // is bound (RPID), else the global fetch. Dispatches the RPID hop
  // in-process instead of through the public edge (which drops same-account
  // loopback fetches). `| undefined` so the caller can pass through an
  // absent binding under exactOptionalPropertyTypes.
  fetchImpl?: typeof fetch | undefined
}): IdClientService {
  // Spread the override in only when present so the SDKs' optional fetch
  // params (no explicit `| undefined`) aren't handed an undefined under
  // exactOptionalPropertyTypes; absent → SDK uses the global fetch.
  const fetchImplOpt = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}
  const fetchOpt = opts.fetchImpl ? { fetch: opts.fetchImpl } : {}
  const verifier = new SessionVerifier({
    apiBase: opts.apiBase,
    cacheTtlMs: 30_000,
    ...fetchImplOpt,
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
      const res = await signoutSession(bearer, { apiBase: opts.apiBase, ...fetchImplOpt })
      if (!res.ok) throw new Error('rpid_transport_error')
    },
    async batchLookupUsers(userIds): Promise<UserBatchEntry[]> {
      if (userIds.length === 0) return []
      const result = await batchLookupUsers({
        baseUrl: opts.apiBase,
        apiKey: opts.apiKey,
        userIds: userIds as ReadonlyArray<`user_${string}`>,
        ...fetchOpt,
      })
      return result.users.map((u) => ({
        userId: u.user_id,
        email: u.email,
        emailVerified: u.email_verified,
        displayName: u.display_name,
        pictureUrl: u.picture_url,
      }))
    },
  }
}
