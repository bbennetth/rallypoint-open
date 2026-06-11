import type { D1Database, ExecutionContext, Fetcher } from '@cloudflare/workers-types'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'
import { buildLogger, type Logger } from './logger.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import { buildServices } from './services/index.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'

// Cloudflare Worker entrypoint for planner-api (replaces the retired Node
// server.ts). Bindings arrive per-request in `env`:
//   - DB     — the D1 database (passed to buildD1Repos)
//   - ASSETS — static-assets binding serving the planner-web SPA for
//              non-/api paths; the Worker only handles /api/*
//              (wrangler.toml `assets.run_worker_first`), so we never call
//              ASSETS.fetch.
//   - string vars/secrets (PLANNER_API_KEY, PLANNER_SESSION_KEY_V1,
//     PLANNER_UI_ORIGIN, RPID_API_URL, LISTS_API_URL, EVENTS_API_URL, …)
//     that feed parseEnv.
//
// planner is a pure BFF: it proxies lists/events/RPID over HTTP and
// owns only the sessions store. It has NO realtime/Durable Object, NO
// object store, and NO background pruner — so this Worker is fetch-only
// (no `scheduled` handler, no Durable Object export).

interface WorkerEnv {
  DB: D1Database
  ASSETS?: Fetcher
  // Cloudflare service bindings to the same-account producers
  // (wrangler.toml [[env.<env>.services]]): RPID -> rallypoint-id-<env>,
  // LISTS -> rallypoint-lists-<env>, EVENTS -> rallypoint-events-<env>.
  // Present only in deployed envs; absent in local `wrangler dev`, where
  // buildServices falls back to global fetch.
  RPID?: Fetcher
  LISTS?: Fetcher
  EVENTS?: Fetcher
  [key: string]: unknown
}

interface Deps {
  env: Env
  logger: Logger
  repos: Repos
  services: Services
}

// Built once per isolate and reused across requests (bindings are
// isolate-stable), so per-isolate caches persist instead of rebuilding
// every request.
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
  const logger = buildLogger(parsed)
  // Bind each service-binding fetcher when present (deployed envs); else
  // undefined so buildServices uses the global fetch (local dev).
  const rpidFetch = env.RPID ? (env.RPID.fetch.bind(env.RPID) as unknown as typeof fetch) : undefined
  const listsFetch = env.LISTS
    ? (env.LISTS.fetch.bind(env.LISTS) as unknown as typeof fetch)
    : undefined
  const eventsFetch = env.EVENTS
    ? (env.EVENTS.fetch.bind(env.EVENTS) as unknown as typeof fetch)
    : undefined
  deps = {
    env: parsed,
    logger,
    repos: buildD1Repos(createDb(env.DB)),
    services: buildServices(parsed, { rpidFetch, listsFetch, eventsFetch }),
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
        repos: d.repos,
        services: d.services,
      })
    }
    return app.fetch(request, env, ctx)
  },
}
