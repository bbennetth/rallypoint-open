import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { Logger } from '@rallypoint/logger'
import type { IdClientService, UserBatchEntry } from './types.js'

// Delegates to the `Service<IdRPC>` binding (PR 2 of feat/rpc-bindings).
// The legacy SessionVerifier + HTTP SDK calls + EVENTS_API_KEY bearer are
// gone — id-api's IdRPC class is the contract. PR 3 deletes the old
// HTTP /api/v1/sdk/session/verify route and the EVENTS_API_KEY secret.

export function createIdClientService(
  binding: Service<IdRPC>,
  // Isolate-scoped logger so a swallowed lookup failure still lands in
  // the app's log pipeline. Optional: the RPC test harness builds
  // services without one and falls back to console.
  logger?: Logger,
): IdClientService {
  return {
    async verifyRpidBearer(bearer) {
      let info: Awaited<ReturnType<IdRPC['verifySession']>>
      try {
        info = await binding.verifySession(bearer)
      } catch (err) {
        // RPC dispatch failure (id-api isolate down, network blip, etc.)
        // — distinct from a verified-invalid bearer. Throw so the session
        // middleware returns 503 and keeps the row.
        throw new Error('rpid_transport_error', { cause: err })
      }
      if (info === null) return { ok: false, revoked: true }
      return { ok: true, userId: info.sub }
    },
    async signoutRpidBearer(bearer) {
      try {
        await binding.signoutSession(bearer, { client: 'events' })
      } catch (err) {
        throw new Error('rpid_transport_error', { cause: err })
      }
    },
    async batchLookupUsers(userIds): Promise<UserBatchEntry[]> {
      if (userIds.length === 0) return []
      // Display-name enrichment only — every caller already renders
      // `display_name ?? <fallback>` for ids RPID has no record of, so
      // an id-api outage degrades to unnamed rows instead of 500ing the
      // page around them. Deliberately unlike verifyRpidBearer above,
      // where a transport error must stay loud (it gates access).
      // Logged at error level, not swallowed silently, so an outage —
      // or an unbound RPID in local dev — is still diagnosable. This
      // path no longer reaches the top-level error handler, so it also
      // no longer reaches PostHog; wiring per-request exception capture
      // into an isolate-scoped service is tracked as a follow-up.
      let users: Awaited<ReturnType<IdRPC['batchLookupUsers']>>
      try {
        users = await binding.batchLookupUsers([...userIds], { client: 'events' })
      } catch (err) {
        const msg = 'batchLookupUsers failed; degrading to no display names'
        if (logger) logger.error({ err, userCount: userIds.length }, msg)
        else console.error(msg, err)
        return []
      }
      return users.map((u) => ({
        userId: u.user_id,
        email: u.email,
        emailVerified: u.email_verified,
        displayName: u.display_name,
        pictureUrl: u.picture_url,
      }))
    },
  }
}
