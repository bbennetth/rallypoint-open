import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { UserBatchEntry as IdClientUserBatchEntry } from '@rallypoint/id-client'
import type { ProfilesClientService } from './types.js'

export function createProfilesClientService(binding: Service<IdRPC>): ProfilesClientService {
  return {
    async lookup(userId) {
      const users = await binding.batchLookupUsers([userId], { client: 'planner' })
      const first = users[0]
      return (first ?? null) as IdClientUserBatchEntry | null
    },
  }
}
