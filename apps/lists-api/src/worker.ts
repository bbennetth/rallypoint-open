import type {
  D1Database,
  DurableObjectNamespace,
  ExecutionContext,
  Fetcher,
} from '@cloudflare/workers-types'
import {
  createDoRealtimeBus,
  type RealtimeBus,
  type RealtimeHubNamespace,
} from '@rallypoint/realtime'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'
import { buildLogger, type Logger } from './logger.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import { buildServices } from './services/index.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'

// Cloudflare Worker entrypoint for lists-api (replaces the retired Node
// server.ts). Bindings arrive per-request in `env`:
//   - DB     — the D1 database (passed to buildD1Repos)
//   - HUB    — the RealtimeHub Durable Object namespace. The publish side
//              (createDoRealtimeBus) resolves a channel DO and POSTs the
//              pointer envelope; the WS-upgrade route (routes/realtime.ts)
//              forwards the socket to the channel DO via c.var.hub.
//   - ASSETS — static-assets binding serving the lists-web SPA for non-/api
//              paths; the Worker only handles /api/* (wrangler.toml
//              `assets.run_worker_first`), so we never call ASSETS.fetch.
//   - string vars/secrets (LISTS_API_KEY, LISTS_SESSION_KEY_V1,
//     REALTIME_TOKEN_HMAC_KEY, EVENTS_API_KEY, PLANNER_API_KEY,
//     LISTS_UI_ORIGIN, RPID_API_URL, …) that feed parseEnv.
//
// lists has no object store and no background pruner, so (unlike id-api)
// there is no `scheduled` handler — just `fetch`.

interface WorkerEnv {
  DB: D1Database
  HUB: DurableObjectNamespace
  ASSETS?: Fetcher
  // Cloudflare service binding to id-api (wrangler.toml [[env.<env>.services]]
  // RPID -> rallypoint-id-<env>). Present only in deployed envs; absent in
  // local `wrangler dev`, where buildServices falls back to global fetch.
  RPID?: Fetcher
  [key: string]: unknown
}

interface Deps {
  env: Env
  logger: Logger
  repos: Repos
  services: Services
  realtime: RealtimeBus
  hub: RealtimeHubNamespace
}

// Built once per isolate and reused across requests (bindings are
// isolate-stable), so per-isolate caches persist instead of rebuilding
// every request.
let deps: Deps | null = null
let app: ReturnType<typeof buildApp> | null = null

function ensureDeps(env: WorkerEnv): Deps {
  if (deps) return deps
  // parseEnv reads string vars/secrets; the D1/HUB/ASSETS bindings are
  // objects, so feed it only the string-valued keys.
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') vars[k] = v
  }
  const parsed = parseEnv(vars as NodeJS.ProcessEnv)
  const logger = buildLogger(parsed)
  // A DurableObjectNamespace satisfies the structural RealtimeHubNamespace
  // (idFromName + get); see do-bus.ts.
  const hub = env.HUB as unknown as RealtimeHubNamespace
  // Bind the service-binding fetcher when present (deployed envs); else
  // undefined so buildServices uses the global fetch (local dev).
  const rpidFetch = env.RPID ? (env.RPID.fetch.bind(env.RPID) as unknown as typeof fetch) : undefined
  deps = {
    env: parsed,
    logger,
    repos: buildD1Repos(createDb(env.DB)),
    services: buildServices(parsed, { rpidFetch }),
    realtime: createDoRealtimeBus({
      hub,
      onError: (err) => logger.warn({ err }, 'realtime publish failed'),
    }),
    hub,
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
        realtime: d.realtime,
        hub: d.hub,
      })
    }
    return app.fetch(request, env, ctx)
  },
}

// The RealtimeHub Durable Object class must be exported from the Worker
// entry so wrangler can bind the HUB namespace to it (wrangler.toml
// [[durable_objects.bindings]] + [[migrations]] new_classes).
export { RealtimeHub } from '@rallypoint/realtime'
