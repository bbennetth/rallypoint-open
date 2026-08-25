import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { UserBatchEntry as IdClientUserBatchEntry } from '@rallypoint/id-client'
import type { ProfilesClientService } from './types.js'

// Resolves a single user's public profile via the `Service<IdRPC>`
// binding; returns the first row or null. id-api guarantees
// `user_<ulid>` format on the id field, so the cast back to the
// branded `UserId` type is safe.
//
// Calls the `batchLookupUsers` RPC directly rather than going through
// `IdClientService`, so unlike that one it still THROWS on a transport
// failure. That suits a single-profile read, where an empty result and
// a failed call mean different things — but it is a deliberate
// divergence, not parity. No caller yet.

export function createProfilesClientService(binding: Service<IdRPC>): ProfilesClientService {
  return {
    async lookup(userId) {
      const users = await binding.batchLookupUsers([userId], { client: 'events' })
      const first = users[0]
      return (first ?? null) as IdClientUserBatchEntry | null
    },
  }
}
