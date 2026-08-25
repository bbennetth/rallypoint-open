// Public types for SDK consumers. Inlined (not re-exported from
// `@rallypoint/shared`) so this package can be installed standalone
// from npm without dragging in a private internal package — closes #106.
//
// If the shared `UserInfo` shape ever changes, mirror the change here
// AND in @rallypoint/shared/src/index.ts. The two files were kept in
// sync as of Phase 0 of the platform/v-1.1 events redesign.

export type UserId = `user_${string}`

// OIDC-shape userinfo superset returned by /session and by the SDK's
// verifySession().
export interface UserInfo {
  sub: UserId
  email: string
  email_verified: boolean
  preferred_username: string
  // Always present — sourced from the NOT-NULL username column (#295).
  name: string
  first_name: string | null
  last_name: string | null
  picture: string | null
  updated_at: string // ISO-8601
}

// Result of a batch user lookup against /api/v1/sdk/users/batch-lookup.
// Missing user_ids are silently dropped from the response.
// `display_name` is the (non-unique) username column; there is no
// separate handle.
export interface UserBatchEntry {
  user_id: UserId
  email: string
  email_verified: boolean
  display_name: string | null
  first_name: string | null
  last_name: string | null
  picture_url: string | null
}

// Error shape used by settings-related RPC error handling. Kept here
// (rather than deleted with the retired fetch-based settings.ts) since
// ~20 consumer apps import it to type their own RPC-based settings
// error handling against the same `{status, code}` shape.
export class SettingsError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SettingsError'
    this.status = status
    this.code = code
  }
}
