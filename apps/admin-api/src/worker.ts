/// <reference types="@cloudflare/workers-types" />
import type { D1Database, ExecutionContext, Fetcher, Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { FitnessRPC } from '@rallypoint/fitness-api'
import type { EventsRPC } from '@rallypoint/events-api'
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
//   - string vars/secrets (ADMIN_SESSION_KEY_V1, ADMIN_USER_IDS, …) that
//     feed parseEnv.
//
// No Durable Objects, no R2, no cron — admin is a thin allowlist-gated BFF.

export interface WorkerEnv {
  DB: D1Database
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
  deps = {
    env: parsed,
    logger,
    flushLogs,
    repos: buildD1Repos(createDb(env.DB)),
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
}
