import type { Env } from './env.js'
import type { Logger } from './logger.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'
import type { PasswordHasher } from './crypto/password.js'
import type { SessionRecord } from './repos/session.js'
import type { SessionCache } from './session/cache.js'
import type { OAuthProviders } from './services/oauth/index.js'

// Type-level extension of Hono's request context. Variables we
// attach in middleware live in `Variables`.

// SSO client identifier — must match the values in
// CLIENT_ALLOWLIST in routes/sso.ts. Still in use as the
// `RpcCallerContext.client` field on the `IdRPC` RPC methods so
// callers can identify themselves to id-api for compartmentalisation
// (e.g. an `events` caller may not exchange a `lists`-minted SSO
// code). The legacy `appApiKeyClient` HonoVar + the
// `requireAppApiKey` middleware that set it were removed in PR 3 of
// feat/rpc-bindings.
export type AppApiKeyClient =
  | 'events'
  | 'lists'
  | 'money'
  | 'planner'
  | 'fitness'
  | 'admin'
  // ai-api's deletion sweep (listDeletedUserIds) — not an SSO client.
  | 'ai'

export type HonoVars = {
  env: Env
  logger: Logger
  requestId: string
  repos: Repos
  services: Services
  passwordHasher: PasswordHasher
  sessionCache?: SessionCache
  session?: SessionRecord
  oauthProviders: OAuthProviders
}

export type HonoApp = {
  Variables: HonoVars
}
