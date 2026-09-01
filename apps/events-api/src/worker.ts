/// <reference types="@cloudflare/workers-types" />
import type { D1Database, DurableObjectNamespace, ExecutionContext, Fetcher, R2Bucket, Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { AiRPC } from '@rallypoint/ai-api'
import type { AiRunResult, AiRunner } from '@rallypoint/ai'
import type { ListsRPC } from '@rallypoint/lists-api'
import type { MoneyRPC } from '@rallypoint/money-api'
import {
  createDoRealtimeBus,
  type RealtimeBus,
  type RealtimeHubNamespace,
} from '@rallypoint/realtime'
import type { RateLimitCounterNamespace } from '@rallypoint/rate-limit'
import { warmD1AndLog, isWarmTick } from '@rallypoint/api-kit'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'
import { buildLoggerWithFlush, type Logger } from './logger.js'
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
//   - RATE_LIMITS  — the RateLimitCounter Durable Object namespace (#881):
//                    one DO per token bucket, replacing the per-request D1
//                    write in the rate limiter.
//   - HUB          — the RealtimeHub Durable Object namespace. The publish
//                    side (createDoRealtimeBus) resolves a channel DO and
//                    POSTs the pointer envelope; the WS-upgrade route
//                    (routes/realtime.ts) forwards the socket to the channel
//                    DO via c.var.hub.
//   - ASSETS       — static-assets binding serving the events-web SPA for
//                    non-/api paths; the Worker only handles /api/*
//                    (wrangler.toml `assets.run_worker_first`), so we never
//                    call ASSETS.fetch ourselves.
//   - string vars/secrets (EVENTS_SESSION_KEY_V1,
//     REALTIME_TOKEN_HMAC_KEY, …) that feed parseEnv.

export interface WorkerEnv {
  DB: D1Database
  // R2 bucket binding for map image + ticket object storage (#409).
  OBJECT_STORE: R2Bucket
  HUB: DurableObjectNamespace
  RATE_LIMITS: DurableObjectNamespace
  ASSETS?: Fetcher
  // Cloudflare WorkerEntrypoint RPC bindings to same-account producers
  // (wrangler.toml [[services]] + [[env.<env>.services]]): RPID -> IdRPC on
  // rallypoint-id, LISTS -> ListsRPC, MONEY -> MoneyRPC. Required in every
  // env (local dev uses wrangler's dev registry; both Workers must be up
  // under the same dev session — `scripts/dev.sh` boots all 5). Service is
  // typed so route code can call `env.RPID.verifySession(token)` directly.
  RPID?: Service<IdRPC>
  LISTS?: Service<ListsRPC>
  MONEY?: Service<MoneyRPC>
  // Workers AI binding for the admin lineup-ingestion extraction
  // (wrangler.toml [ai]). Optional so tests and AI-less deploys keep
  // working — the ingest RPC reports 'ai_unavailable' when absent.
  AI?: AiRunner<AiRunResult>
  // Typed RPC binding to ai-api's AiRPC entrypoint — AI trace-corpus
  // ingest for the extraction calls. Optional: absent (dev) just means
  // untraced.
  AI_TRACES?: Service<AiRPC>
  [key: string]: unknown
}

interface Deps {
  env: Env
  logger: Logger
  flushLogs: () => Promise<void>
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

export function ensureDeps(env: WorkerEnv): Deps {
  if (deps) return deps
  // parseEnv reads string vars/secrets; the D1/HUB/ASSETS bindings are
  // objects, so feed it only the string-valued keys.
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') vars[k] = v
  }
  const parsed = parseEnv(vars as NodeJS.ProcessEnv)
  const { logger, flushLogs } = buildLoggerWithFlush(parsed)
  // A DurableObjectNamespace satisfies the structural RealtimeHubNamespace
  // (idFromName + get); see do-bus.ts.
  const hub = env.HUB as unknown as RealtimeHubNamespace
  // Same structural-assignability story as HUB: a real DurableObjectNamespace
  // satisfies RateLimitCounterNamespace (idFromName + get).
  const repos = buildD1Repos(
    createDb(env.DB),
    env.RATE_LIMITS as unknown as RateLimitCounterNamespace,
  )
  const services = buildServices(
    parsed,
    { objectStore: env.OBJECT_STORE },
    {
      ...(env.RPID ? { rpid: env.RPID } : {}),
      ...(env.LISTS ? { lists: env.LISTS } : {}),
      ...(env.MONEY ? { money: env.MONEY } : {}),
    },
    logger,
  )
  // Storage port for the pruner — a thin wrapper over the full objectStore
  // so pruner.ts doesn't depend on the Services type.
  const storage: EventsStoragePort = {
    deleteObject: (key: string) => services.objectStore.deleteObject(key),
  }
  deps = {
    env: parsed,
    logger,
    flushLogs,
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
        flushLogs: d.flushLogs,
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
  async scheduled(event: { cron?: string }, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const d = ensureDeps(env)

    // Every tick pings D1 so the storage object never idle-evicts; the
    // pruner/weather jobs only run on their own hourly cron (a missing
    // cron — `wrangler dev --test-scheduled` with no ?cron= — still runs
    // them so local smoke keeps working).
    const jobs: Promise<unknown>[] = [warmD1AndLog(env.DB, d.logger)]
    if (!isWarmTick(event.cron)) {
      // Soft-delete hard-purge sweep (§5.1.1) + weather pre-warmer. The
      // Cron Trigger drives the cadence; we just fire one tick of each on
      // the isolate-cached handles (built once in ensureDeps).
      jobs.push(d.pruner.tickOnce(), d.weather.tickOnce())
    }
    ctx.waitUntil(
      Promise.allSettled(jobs)
        .then((results) => {
          for (const result of results) {
            if (result.status === 'rejected') {
              d.logger.warn(
                { err: result.reason instanceof Error ? result.reason.message : String(result.reason) },
                'events-worker: scheduled tick threw',
              )
            }
          }
        })
        // Drain the warn+ log buffer for the cron path — no per-request
        // logFlush middleware runs here, and a cron-only isolate may be
        // evicted before any HTTP request flushes it.
        .finally(() => d.flushLogs()),
    )
  },
}

// The RealtimeHub Durable Object class must be exported from the Worker
// entry so wrangler can bind the HUB namespace to it (wrangler.toml
// [[durable_objects.bindings]] + [[migrations]] new_classes).
export { RealtimeHub } from '@rallypoint/realtime'

// Same for the per-bucket rate-limit counter DO (#881): wrangler binds the
// RATE_LIMITS namespace to this export ([[durable_objects.bindings]] +
// [[migrations]] new_sqlite_classes).
export { RateLimitCounter } from '@rallypoint/rate-limit'

// Named WorkerEntrypoint exposing the cross-Worker SDK surface as typed
// RPC methods (PR 1 of feat/rpc-bindings). See ./rpc.ts.
export { EventsRPC } from './rpc.js'

// DTO/result types for the admin system-events RPC surface — imported by
// admin-api's service layer (mirrors how fitness-shared exports DTOs).
export type {
  AdminConflict,
  AdminForbidden,
  AdminInvalid,
  AdminListSystemEventsOpts,
  AdminNotFound,
  AdminOk,
  AdminSystemEventsPage,
  SystemEventDto,
  AdminIngestFailed,
  AdminIngestLineupResult,
  AdminApproveLineupIngestionResult,
  LineupIngestApplied,
  LineupIngestionDto,
  LineupIngestionProposal,
  AdminArtistMbReviewResult,
  AdminDecideArtistMbReviewResult,
  AdminListArtistsOpts,
  AdminPatchArtistResult,
} from './services/rpc-core/index.js'
