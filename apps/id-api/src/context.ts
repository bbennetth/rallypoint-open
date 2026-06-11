import type { Env } from './env.js'
import type { Logger } from './logger.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'
import type { PasswordHasher } from './crypto/password.js'
import type { SessionRecord } from './repos/session.js'
import type { SessionCache } from './session/cache.js'

// Type-level extension of Hono's request context. Variables we
// attach in middleware live in `Variables`.

// SSO client identifier — must match the values in
// CLIENT_ALLOWLIST in routes/sso.ts and the per-app key env names in
// middleware/app-api-key.ts.
export type AppApiKeyClient = 'events' | 'lists' | 'money' | 'planner'

export type HonoVars = {
  env: Env
  logger: Logger
  requestId: string
  repos: Repos
  services: Services
  passwordHasher: PasswordHasher
  sessionCache?: SessionCache
  session?: SessionRecord
  // Set by requireAppApiKey middleware to the client identifier of
  // the matched key. SDK handlers compare this against the resource's
  // own client field (e.g. sso_codes.client) to enforce per-app
  // compartmentalisation: an EVENTS key can't exchange a LISTS code.
  // Phase 0 follow-up to issue #159.
  appApiKeyClient?: AppApiKeyClient
}

export type HonoApp = {
  Variables: HonoVars
}
