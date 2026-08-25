// @rallypoint/id-client — public surface.
//
// - `signinUrl` / `signupUrl` to redirect users to the hosted UI.
// - Shared types (`UserInfo`, `UserBatchEntry`, `SettingsError`) used
//   by RPC-based consumers across the CF-native apps.
//
// React (optional peer dep; lives at `@rallypoint/id-client/react`):
//   - `useSession` hook for browser consumers — see ./react/index.ts
//
// NOTE: the fetch-based server-to-server helpers (`SessionVerifier`,
// `verifySessionOnce`, `signoutSession`, `batchLookupUsers`,
// `getSettings`/`patchSettings`) were retired — all CF-native apps now
// call id-api directly via the RPC service binding instead (R3).

export type {
  UserInfo,
  UserId,
  UserBatchEntry,
} from './types.js'

export { SettingsError } from './types.js'

export {
  signinUrl,
  signupUrl,
  type SigninUrlOptions,
  type SignupUrlOptions,
} from './signin-url.js'
