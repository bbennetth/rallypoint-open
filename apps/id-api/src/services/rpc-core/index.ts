// Barrel for the cross-Worker RPC core fns. Both the legacy HTTP
// handlers (apps/id-api/src/routes/*) and the IdRPC `WorkerEntrypoint`
// class (apps/id-api/src/rpc.ts) import from here.
export type { IdRpcDeps, CoreCaller, CallerContext } from './deps.js'
export { toUserInfo } from './user-info.js'
export {
  verifySessionCore,
  signoutSessionCore,
  reauthPasswordCore,
  type ReauthResult,
} from './session-core.js'
export {
  exchangeSsoCodeCore,
  type SsoExchangeResult,
  type SsoExchangeSuccess,
} from './sso-core.js'
export {
  batchLookupUsersCore,
  type UserBatchEntry,
} from './users-core.js'
export { listDeletedUserIdsCore } from './deleted-users-core.js'
export {
  getSettingsCore,
  patchSettingsCore,
  type SettingsResult,
  type SettingsOk,
  type SettingsAccessDenied,
} from './settings-core.js'
