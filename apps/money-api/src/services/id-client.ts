import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { IdClientService } from './types.js'

// Delegates to the `Service<IdRPC>` binding (PR 2 of feat/rpc-bindings).
// Replaces the legacy MONEY_API_KEY + HTTP path. PR 3 deletes the env var.

export function createIdClientService(binding: Service<IdRPC>): IdClientService {
  return {
    async verifyRpidBearer(bearer) {
      let info: Awaited<ReturnType<IdRPC['verifySession']>>
      try {
        info = await binding.verifySession(bearer)
      } catch (err) {
        throw new Error('rpid_transport_error', { cause: err })
      }
      if (info === null) return { ok: false, revoked: true }
      return { ok: true, userId: info.sub }
    },
    async signoutRpidBearer(bearer) {
      try {
        await binding.signoutSession(bearer, { client: 'money' })
      } catch (err) {
        throw new Error('rpid_transport_error', { cause: err })
      }
    },
  }
}
