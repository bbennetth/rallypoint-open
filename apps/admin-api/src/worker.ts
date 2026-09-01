/// <reference types="@cloudflare/workers-types" />
import type {
  D1Database,
  DurableObjectNamespace,
  ExecutionContext,
  Fetcher,
  Service,
} from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { FitnessRPC } from '@rallypoint/fitness-api'
import type { EventsRPC } from '@rallypoint/events-api'
import type { RateLimitCounterNamespace } from '@rallypoint/rate-limit'
import { warmD1AndLog } from '@rallypoint/api-kit'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'
import { buildLoggerWithFlush, type Logger } from './logger.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import { buildServices } from './services/index.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'

// Cloudflare Worker entrypoint for admin-api. Bindings arrive per-request
// in `env`:
//   - DB      — the D1 database (sessions + rate_limits only)
//   - ASSETS  — static-assets binding serving the admin-web SPA for
//               non-/api paths; the Worker only handles /api/*
//               (wrangler.toml `assets.run_worker_first`).
//   - RPID    — typed RPC binding to id-api's IdRPC entrypoint.
//   - FITNESS — typed RPC binding to fitness-api's FitnessRPC entrypoint
//               (the exercise-submission review queue).
//   - EVENTS  — typed RPC binding to events-api's EventsRPC entrypoint
//               (system-owned events management).
//   - RATE_LIMITS — the RateLimitCounter Durable Object namespace (#881):
//               one DO per token bucket, replacing the per-request D1
//               write in the rate limiter.
//   - string vars/secrets (ADMIN_SESSION_KEY_V1, ADMIN_USER_IDS, …) that
//     feed parseEnv.
//
// No R2 — admin is a thin allowlist-gated BFF. RATE_LIMITS is its one
// Durable Object (#881). Its only cron is the D1 keep-warm ping
// (wrangler.toml [triggers], every 5 minutes) that stops the storage
// object idle-evicting between requests.

export interface WorkerEnv {
  DB: D1Database
  RATE_LIMITS: DurableObjectNamespace
  ASSETS?: Fetcher
  RPID?: Service<IdRPC>
  FITNESS?: Service<FitnessRPC>
  EVENTS?: Service<EventsRPC>
  [key: string]: unknown
}

interface Deps {
  env: Env
  logger: Logger
  flushLogs: () => Promise<void>
  repos: Repos
  services: Services
}

// Built once per isolate and reused across requests (bindings are
// isolate-stable), so per-isolate caches persist instead of rebuilding
// every request.
let deps: Deps | null = null
let app: ReturnType<typeof buildApp> | null = null

export function ensureDeps(env: WorkerEnv): Deps {
  if (deps) return deps
  // parseEnv reads string vars/secrets; the D1/ASSETS bindings are objects,
  // so feed it only the string-valued keys.
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') vars[k] = v
  }
  const parsed = parseEnv(vars as NodeJS.ProcessEnv)
  const { logger, flushLogs } = buildLoggerWithFlush(parsed)
  // A real DurableObjectNamespace satisfies the structural
  // RateLimitCounterNamespace (idFromName + get); see do-bus.ts in
  // events-api for the same pattern.
  deps = {
    env: parsed,
    logger,
    flushLogs,
    repos: buildD1Repos(
      createDb(env.DB),
      env.RATE_LIMITS as unknown as RateLimitCounterNamespace,
    ),
    services: buildServices(parsed, {
      ...(env.RPID ? { rpid: env.RPID } : {}),
      ...(env.FITNESS ? { fitness: env.FITNESS } : {}),
      ...(env.EVENTS ? { events: env.EVENTS } : {}),
    }),
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
      })
    }
    return app.fetch(request, env, ctx)
  },

  // The warm ping is the only cron, so event.cron is deliberately ignored;
  // a future domain cron must add an isWarmTick(event.cron) dispatch like
  // lists/events/ai.
  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const d = ensureDeps(env)
    // .finally drains the warn+ log buffer for the cron path — no
    // per-request logFlush middleware runs here, and a cron-only isolate
    // may be evicted before any HTTP request flushes it.
    ctx.waitUntil(warmD1AndLog(env.DB, d.logger).finally(() => d.flushLogs()))
  },
}

// The per-bucket rate-limit counter DO (#881): wrangler binds the
// RATE_LIMITS namespace to this export ([[durable_objects.bindings]] +
// [[migrations]] new_sqlite_classes).
export { RateLimitCounter } from '@rallypoint/rate-limit'
