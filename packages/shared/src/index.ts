// Cross-target validators usable in both the API and the hosted
// UI. Slice 2 onwards adds the real signup/signin schemas; for
// slice 1 we export the OIDC userinfo type that the SDK and UI
// will both consume.

export type UserId = `user_${string}`

// OIDC-shape userinfo superset returned by /session and by the
// SDK's verifySession(). Phase B's /userinfo becomes a renamer
// rather than a rewrite (decision lives in docs/design/).
export interface UserInfo {
  sub: UserId
  email: string
  email_verified: boolean
  // `preferred_username` and `name` are both the (non-unique,
  // editable) display name sourced from the username column (NOT NULL),
  // so `name` is always present — see #295.
  preferred_username: string
  name: string
  first_name: string | null
  last_name: string | null
  picture: string | null
  updated_at: string // ISO-8601
}

export const TENANT_DEFAULT = 'rallypoint' as const

// Token prefix constants — referenced by every slice that issues
// or validates one.
export const TOKEN_PREFIXES = {
  session: 'rps_live_',
  emailVerify: 'rpv_',
  passwordReset: 'rpr_',
  emailChange: 'rpc_',
  sso: 'rpsso_',
} as const

export type TokenKind = keyof typeof TOKEN_PREFIXES

// Anti-fingerprint "not found" envelope (HTTP 404). Emitted by every
// app's `notFound` fallback, the SDK app-api-key gates, and RPID's
// admin-token gate when a namespace is disabled — so an unconfigured or
// gated endpoint is indistinguishable from a genuinely missing route.
// planner-api's `isSdkGateMiss` discriminator matches on this EXACT shape
// to remap a zero-keys gate 404 into a 502 bad_gateway; sourcing both the
// producers and the discriminator from one constant guarantees they can
// never drift apart (#358).
export const ANTI_FINGERPRINT_NOT_FOUND = {
  code: 'not_found',
  message: 'Route not found.',
} as const

// Generic per-user settings store (RPID `user_settings`). The settings
// document is opaque JSON — RPID does NO per-key schema validation;
// front ends own typing/sanitising. `'shared'` is the cross-app
// namespace where cross-app prefs (e.g. theme) live so they follow the
// user across every Rallypoint app; each app may additionally read/write
// its own private namespace (=== its app client id).
export const SHARED_SETTINGS_NAMESPACE = 'shared' as const

// Max serialized byte size of a single settings document (per
// user+namespace). PATCH bodies whose merged result would exceed this
// are rejected with 400. Generous enough for realistic front-end
// preference bags; small enough that the JSONB column can't be abused
// as bulk storage.
export const SETTINGS_MAX_BYTES = 16 * 1024

export * from './validators.js'
export * from './avatar-constraints.js'
export * from './avatar-geometry.js'
export * from './file-type.js'
