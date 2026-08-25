import type { Env } from '../../env.js'
import type { Logger } from '../../logger.js'
import type { Repos } from '../../repos/types.js'
import type { Services } from '../types.js'
import type { PasswordHasher } from '../../crypto/password.js'
import type { SessionCache } from '../../session/cache.js'
import type { AppApiKeyClient } from '../../context.js'

// Dependencies the cross-Worker RPC core fns need. Mirrors the subset of
// `c.var` they used to read from a Hono context. The HTTP handler passes
// these from its `c.var`; the IdRPC class passes them from a
// `worker.ts`-scoped isolate singleton.
export interface IdRpcDeps {
  env: Env
  logger: Logger
  repos: Repos
  services: Services
  passwordHasher: PasswordHasher
  sessionCache?: SessionCache
}

// Caller-identifying info threaded into audit rows (#23/#24). The HTTP
// handler fills these from the incoming Request; the RPC method takes
// them as method params (so the consumer Worker can forward the *user's*
// IP/UA, not its own service-binding loopback). PR 1 leaves CallerContext
// optional — RPC callers won't fill it until PR 2 wires them through.
export interface CallerContext {
  ip: string | null
  userAgent: string | null
  // The first-party Worker initiating the call (events / lists / money /
  // planner). Required for any RPC method that performs per-app
  // compartmentalisation (e.g. settings namespace gating, SSO code
  // compartment). The legacy HTTP path reads this from
  // `c.var.appApiKeyClient`; the RPC method takes it as an explicit
  // method param.
  callerClient?: AppApiKeyClient
}

export type CoreCaller = CallerContext
