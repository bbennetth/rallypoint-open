/// <reference types="@cloudflare/workers-types" />
import type { D1Database, ExecutionContext, Fetcher, R2Bucket } from '@cloudflare/workers-types'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'
import { buildLoggerWithFlush, type Logger } from './logger.js'
import { runPrunerTick } from './pruner.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import { buildServices } from './services/index.js'
import { createPasswordHasher, type PasswordHasher } from './crypto/password.js'
import { SessionCache } from './session/cache.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'

// Cloudflare Worker entrypoint for id-api (replaces the retired Node
// server.ts). Bindings arrive per-request in `env`:
//   - DB      — the D1 database (passed to buildD1Repos)
//   - ASSETS  — static-assets binding serving the id-web SPA for non-/api
//               paths; the Worker only handles /api/* + /verify-email
//               (wrangler.toml `assets.run_worker_first`), so we never
//               call ASSETS.fetch ourselves.
//   - string vars/secrets (ARGON2_PEPPER, SESSION_HMAC_KEY, origins,
//     ID_OBJECT_STORE_*, …) that feed parseEnv.

export interface WorkerEnv {
  DB: D1Database
  ASSETS?: Fetcher
  // R2 bucket binding for avatar object storage (#409).
  OBJECT_STORE: R2Bucket
  [key: string]: unknown
}

interface Deps {
  env: Env
  logger: Logger
  flushLogs: () => Promise<void>
  repos: Repos
  services: Services
  passwordHasher: PasswordHasher
  sessionCache: SessionCache
}

// Built once per isolate and reused across requests (bindings are
// isolate-stable), so the in-isolate SessionCache LRU actually persists
// instead of being rebuilt every request. `passwordHasher` and
// `sessionCache` are lifted out of `buildApp` so the `IdRPC`
// WorkerEntrypoint can share the same isolate singletons.
let deps: Deps | null = null
let app: ReturnType<typeof buildApp> | null = null

export function ensureDeps(env: WorkerEnv): Deps {
  if (deps) return deps
  // parseEnv reads string vars/secrets; the D1/ASSETS bindings are
  // objects, so feed it only the string-valued keys.
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') vars[k] = v
  }
  const parsed = parseEnv(vars as NodeJS.ProcessEnv)
  const { logger, flushLogs } = buildLoggerWithFlush(parsed)
  deps = {
    env: parsed,
    logger,
    flushLogs,
    repos: buildD1Repos(createDb(env.DB)),
    services: buildServices(parsed, { objectStore: env.OBJECT_STORE }),
    passwordHasher: createPasswordHasher({ pepper: parsed.ARGON2_PEPPER }),
    sessionCache: new SessionCache(),
  }
  return deps
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const d = ensureDeps(env)
    if (!app) {
      app = buildApp({
        env: d.env,
        logger: d.logger,
        flushLogs: d.flushLogs,
        repos: d.repos,
        services: d.services,
        passwordHasher: d.passwordHasher,
        sessionCache: d.sessionCache,
      })
    }
    return app.fetch(request, env, ctx)
  },

  // Cron Trigger (wrangler.toml [triggers].crons) — the TTL pruner that
  // replaces the Node setInterval driver.
  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const d = ensureDeps(env)
    // .finally drains the warn+ log buffer for the cron path — no
    // per-request logFlush middleware runs here, and a cron-only isolate
    // may be evicted before any HTTP request flushes it.
    ctx.waitUntil(runPrunerTick(d.repos, d.logger, new Date()).finally(() => d.flushLogs()))
  },
}

// Named WorkerEntrypoint exposing the cross-Worker SDK surface as typed
// RPC methods (PR 1 of feat/rpc-bindings). Consumers bind:
//   [[services]] binding="RPID" service="rallypoint-id" entrypoint="IdRPC"
// and call `env.RPID.verifySession(token)` etc. — no Bearer header, no
// API key. The methods read from the same isolate-singleton `deps` the
// fetch handler uses, so the SessionCache LRU is shared between HTTP
// and RPC paths.
export { IdRPC } from './rpc.js'
