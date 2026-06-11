// @rallypoint/id-client — public surface.
//
// Server-side (Node 22+, Workers, Bun, Deno):
//   - `SessionVerifier` + `verifySessionOnce` for /sdk/session/verify
//   - `signinUrl` / `signupUrl` to redirect users to the hosted UI
//
// React (optional peer dep; lives at `@rallypoint/id-client/react`):
//   - `useSession` hook for browser consumers — see ./react/index.ts

export type {
  UserInfo,
  UserId,
  UserBatchEntry,
} from './types.js'

export {
  SessionVerifier,
  verifySessionOnce,
  type VerifySessionOptions,
  type VerifySessionResult,
  type VerifySessionFailure,
} from './verify-session.js'

export {
  signoutSession,
  type SignoutSessionOptions,
  type SignoutSessionResult,
} from './signout-session.js'

export {
  signinUrl,
  signupUrl,
  type SigninUrlOptions,
  type SignupUrlOptions,
} from './signin-url.js'

export {
  batchLookupUsers,
  BatchLookupError,
  BATCH_LOOKUP_MAX,
  type BatchLookupOptions,
  type BatchLookupResult,
} from './batch-lookup.js'

export {
  getSettings,
  patchSettings,
  SettingsError,
  type AppSettings,
  type GetSettingsOptions,
  type PatchSettingsOptions,
} from './settings.js'
