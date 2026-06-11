import type { D1Database, ExecutionContext, Fetcher, R2Bucket } from '@cloudflare/workers-types'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'
import { buildLogger, type Logger } from './logger.js'
import { runPrunerTick } from './pruner.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import { buildServices } from './services/index.js'
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

interface WorkerEnv {
  DB: D1Database
  ASSETS?: Fetcher
  // R2 bucket binding for avatar object storage (#409).
  OBJECT_STORE: R2Bucket
  [key: string]: unknown
}

interface Deps {
  env: Env
  logger: Logger
  repos: Repos
  services: Services
}

// Built once per isolate and reused across requests (bindings are
// isolate-stable), so the in-isolate SessionCache LRU actually persists
// instead of being rebuilt every request.
let deps: Deps | null = null
let app: ReturnType<typeof buildApp> | null = null

function ensureDeps(env: WorkerEnv): Deps {
  if (deps) return deps
  // parseEnv reads string vars/secrets; the D1/ASSETS bindings are
  // objects, so feed it only the string-valued keys.
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') vars[k] = v
  }
  const parsed = parseEnv(vars as NodeJS.ProcessEnv)
  deps = {
    env: parsed,
    logger: buildLogger(parsed),
    repos: buildD1Repos(createDb(env.DB)),
    services: buildServices(parsed, { objectStore: env.OBJECT_STORE }),
  }
  return deps
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const d = ensureDeps(env)
    if (!app) app = buildApp({ env: d.env, logger: d.logger, repos: d.repos, services: d.services })
    return app.fetch(request, env, ctx)
  },

  // Cron Trigger (wrangler.toml [triggers].crons) — the TTL pruner that
  // replaces the Node setInterval driver.
  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const d = ensureDeps(env)
    ctx.waitUntil(runPrunerTick(d.repos, d.logger, new Date()))
  },
}
