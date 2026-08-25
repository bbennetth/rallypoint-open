import { SYSTEM_USER_DISPLAY_NAME, SYSTEM_USER_ID, type UserId } from '@rallypoint/shared'
import { avatarPictureUrl } from '../../avatar-url.js'
import type { CoreCaller, IdRpcDeps } from './deps.js'

// Batch user lookup core. Unknown / soft-deleted users are silently
// dropped (callers tolerate missing entries). This returns PII (email,
// name, avatar), so the caller must identify itself as a known app
// client — the RPC method threads `caller.callerClient` from the
// binding peer. An unidentified caller gets an empty result (the trust
// boundary is the service binding, but requiring a named client keeps
// the lookups attributable and matches every other IdRPC method).

export interface UserBatchEntry {
  user_id: string
  email: string
  email_verified: boolean
  display_name: string
  first_name: string | null
  last_name: string | null
  picture_url: string | null
}

export async function batchLookupUsersCore(
  userIds: string[],
  deps: IdRpcDeps,
  caller: CoreCaller,
): Promise<UserBatchEntry[]> {
  if (!caller.callerClient) {
    deps.logger.warn('batchLookupUsers called without an app client — denying')
    return []
  }
  // De-dup before the DB hit — callers in events-api may pass the same id
  // twice if a user appears in multiple membership rows.
  const unique = Array.from(new Set(userIds))
  // The system sentinel owns platform resources (system events) but has
  // no users row — it must never be signable-in. Resolve it here so
  // consumer apps render "Rallypoint" instead of dropping the entry.
  const sentinel: UserBatchEntry[] = unique.includes(SYSTEM_USER_ID)
    ? [
        {
          user_id: SYSTEM_USER_ID,
          email: '',
          email_verified: true,
          display_name: SYSTEM_USER_DISPLAY_NAME,
          first_name: null,
          last_name: null,
          picture_url: null,
        },
      ]
    : []
  const users = await deps.repos.users.findManyByIds(
    unique.filter((id) => id !== SYSTEM_USER_ID) as UserId[],
  )
  return sentinel.concat(users.map((u) => ({
    user_id: u.id,
    email: u.email,
    email_verified: u.emailVerified,
    display_name: u.username,
    first_name: u.firstName,
    last_name: u.lastName,
    picture_url: avatarPictureUrl(u, deps.env.PUBLIC_BASE_URL),
  })))
}
