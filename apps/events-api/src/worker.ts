import type { D1Database, DurableObjectNamespace, ExecutionContext, Fetcher, R2Bucket } from '@cloudflare/workers-types'
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
import { startEventsPruner, type EventsStoragePort } from './pruner.js'
import { startWeatherRefresher } from './weather-refresher.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'

// Cloudflare Worker entrypoint for events-api. Bindings arrive
// per-request in `env`:
//   - DB           — the D1 database (passed to buildD1Repos)
//   - OBJECT_STORE — R2 bucket binding for map/ticket object storage (#409)
//   - HUB          — the RealtimeHub Durable Object namespace. The publish
//                    side (createDoRealtimeBus) resolves a channel DO and
//                    POSTs the pointer envelope; the WS-upgrade route
//                    (routes/realtime.ts) forwards the socket to the channel
//                    DO via c.var.hub.
//   - ASSETS       — static-assets binding serving the events-web SPA for
//                    non-/api paths; the Worker only handles /api/*
//                    (wrangler.toml `assets.run_worker_first`), so we never
//                    call ASSETS.fetch ourselves.
//   - string vars/secrets (EVENTS_API_KEY, EVENTS_SESSION_KEY_V1,
//     REALTIME_TOKEN_HMAC_KEY, …) that feed parseEnv.

interface WorkerEnv {
  DB: D1Database
  // R2 bucket binding for map image + ticket object storage (#409).
  OBJECT_STORE: R2Bucket
  HUB: DurableObjectNamespace
  ASSETS?: Fetcher
  // Cloudflare service bindings to the same-account producers
  // (wrangler.toml [[env.<env>.services]]): RPID -> rallypoint-id-<env>,
  // LISTS -> rallypoint-lists-<env>, MONEY -> rallypoint-money-<env>.
  // Present only in deployed envs; absent in local `wrangler dev`, where
  // buildServices falls back to global fetch.
  RPID?: Fetcher
  LISTS?: Fetcher
  MONEY?: Fetcher
  [key: string]: unknown
}

interface Deps {
  env: Env
  logger: Logger
  repos: Repos
  services: Services
  realtime: RealtimeBus
  hub: RealtimeHubNamespace
  // Pruner + weather handles built once per isolate so their inflight-dedupe
  // state persists across cron firings. There is no timer — the Cron Trigger
  // drives the cadence via .tickOnce() in `scheduled` below.
  pruner: ReturnType<typeof startEventsPruner>
  weather: ReturnType<typeof startWeatherRefresher>
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
  const repos = buildD1Repos(createDb(env.DB))
  // Bind each service-binding fetcher when present (deployed envs); else
  // undefined so buildServices uses the global fetch (local dev).
  const rpidFetch = env.RPID ? (env.RPID.fetch.bind(env.RPID) as unknown as typeof fetch) : undefined
  const listsFetch = env.LISTS
    ? (env.LISTS.fetch.bind(env.LISTS) as unknown as typeof fetch)
    : undefined
  const moneyFetch = env.MONEY
    ? (env.MONEY.fetch.bind(env.MONEY) as unknown as typeof fetch)
    : undefined
  const services = buildServices(parsed, { objectStore: env.OBJECT_STORE }, { rpidFetch, listsFetch, moneyFetch })
  // Storage port for the pruner — a thin wrapper over the full objectStore
  // so pruner.ts doesn't depend on the Services type.
  const storage: EventsStoragePort = {
    deleteObject: (key: string) => services.objectStore.deleteObject(key),
  }
  deps = {
    env: parsed,
    logger,
    repos,
    services,
    realtime: createDoRealtimeBus({
      hub,
      onError: (err) => logger.warn({ err }, 'realtime publish failed'),
    }),
    hub,
    pruner: startEventsPruner({ repos, logger, storage }),
    weather: startWeatherRefresher({
      repos,
      services,
      logger,
      freshnessMs: parsed.EVENTS_WEATHER_FRESHNESS_MS,
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
        repos: d.repos,
        services: d.services,
        realtime: d.realtime,
        hub: d.hub,
      })
    }
    return app.fetch(request, env, ctx)
  },

  // Cron Trigger (wrangler.toml [triggers].crons) — runs the event
  // hard-purge pruner and the weather pre-warmer. Both are scheduled
  // independently via Promise.allSettled so one failing does not abort
  // the other.
  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const d = ensureDeps(env)

    ctx.waitUntil(
      Promise.allSettled([
        // Soft-delete hard-purge sweep (§5.1.1) + weather pre-warmer. The
        // Cron Trigger drives the cadence; we just fire one tick of each on
        // the isolate-cached handles (built once in ensureDeps).
        d.pruner.tickOnce(),
        d.weather.tickOnce(),
      ]).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            d.logger.warn(
              { err: result.reason instanceof Error ? result.reason.message : String(result.reason) },
              'events-worker: scheduled tick threw',
            )
          }
        }
      }),
    )
  },
}

// The RealtimeHub Durable Object class must be exported from the Worker
// entry so wrangler can bind the HUB namespace to it (wrangler.toml
// [[durable_objects.bindings]] + [[migrations]] new_classes).
export { RealtimeHub } from '@rallypoint/realtime'
