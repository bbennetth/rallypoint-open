import { batchLookupUsers } from '@rallypoint/id-client'
import type { UserId } from '@rallypoint/shared'
import type { ProfilesClientService } from './types.js'

// Wraps the @rallypoint/id-client batch-lookup SDK to resolve a single
// user's public profile (display name + first/last + avatar URL + email),
// presenting LISTS_API_KEY. Used to fold a `profile` into the session
// probe so the user bar can render the real avatar + name.

export function createProfilesClientService(opts: {
  apiBase: string
  apiKey: string
  // Optional fetch override — a Cloudflare service-binding fetcher when one
  // is bound (RPID), else the global fetch. The id-client batch-lookup SDK
  // accepts the override as `fetch`.
  fetchImpl?: typeof fetch | undefined
}): ProfilesClientService {
  // Spread `fetch` in only when present so the SDK's `fetch?` (no explicit
  // `| undefined`) isn't handed undefined; absent → SDK global fetch.
  const fetchOpt = opts.fetchImpl ? { fetch: opts.fetchImpl } : {}
  return {
    async lookup(userId) {
      const { users } = await batchLookupUsers({
        baseUrl: opts.apiBase,
        apiKey: opts.apiKey,
        userIds: [userId as UserId],
        ...fetchOpt,
      })
      return users[0] ?? null
    },
  }
}
