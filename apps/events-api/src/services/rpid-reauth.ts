import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { RpidReauthService } from './types.js'

// Delegates to the `Service<IdRPC>` binding. The producer's
// `reauthPassword` already returns `{ ok, reason? }` so no shape
// translation is needed beyond catching RPC dispatch failures.

export function createRpidReauthService(binding: Service<IdRPC>): RpidReauthService {
  return {
    async verify(userId, password) {
      try {
        const result = await binding.reauthPassword(userId, password, { client: 'events' })
        if (result.ok) return { ok: true }
        return { ok: false, reason: 'reauth_failed' }
      } catch (err) {
        throw new Error('rpid_reauth_transport_error', { cause: err })
      }
    },
  }
}
