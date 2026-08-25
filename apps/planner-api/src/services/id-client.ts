import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { IdClientService } from './types.js'

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
        await binding.signoutSession(bearer, { client: 'planner' })
      } catch (err) {
        throw new Error('rpid_transport_error', { cause: err })
      }
    },
  }
}
