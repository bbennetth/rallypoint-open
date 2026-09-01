/// <reference types="@cloudflare/workers-types" />
import type {
  D1Database,
  DurableObjectNamespace,
  ExecutionContext,
  Fetcher,
  Service,
} from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
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
//   - RATE_LIMITS — the RateLimitCounter Durable Object namespace (#881):
//              one DO per token bucket, replacing the per-request D1 write
//              in the rate limiter.
//   - string vars/secrets (LISTS_SESSION_KEY_V1,
//     REALTIME_TOKEN_HMAC_KEY, LISTS_UI_ORIGIN, RPID_API_URL, …)
//     that feed parseEnv.
//
// lists has no object store, but (like id-api) it exports a `scheduled`
// handler: the hourly recurrence sweep that marks superseded open series
// occurrences 'skipped' (wrangler.toml [triggers].crons).

export interface WorkerEnv {
  DB: D1Database
  HUB: DurableObjectNamespace
  RATE_LIMITS: DurableObjectNamespace
  ASSETS?: Fetcher
  // Typed RPC binding to id-api's IdRPC entrypoint (wrangler.toml
  // [[services]] + [[env.<env>.services]]). Required in every env; PR 2
  // of feat/rpc-bindings replaced the fetch-style fallback with direct
  // method calls (`env.RPID.verifySession(token)` etc.).
  RPID?: Service<IdRPC>
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
  deps = {
    env: parsed,
    logger,
    flushLogs,
    repos,
    services: buildServices(parsed, {
      ...(env.RPID ? { rpid: env.RPID } : {}),
    }),
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
        flushLogs: d.flushLogs,
        repos: d.repos,
        services: d.services,
        realtime: d.realtime,
        hub: d.hub,
      })
    }
    return app.fetch(request, env, ctx)
  },

  // Cron Trigger (wrangler.toml [triggers].crons) — the recurrence sweep.
  // One set-based idempotent UPDATE across all tenants marks superseded
  // open series occurrences 'skipped' so a series never shows more than
  // one active instance; the first run also backfills historical dupes.
  async scheduled(event: { cron?: string }, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const d = ensureDeps(env)
    // Every tick pings D1 so the storage object never idle-evicts; the
    // recurrence sweep only runs on its own hourly cron (a missing cron —
    // `wrangler dev --test-scheduled` with no ?cron= — still sweeps so
    // local smoke keeps working).
    const jobs: Promise<unknown>[] = [warmD1AndLog(env.DB, d.logger)]
    if (!isWarmTick(event.cron)) {
      const todayISO = new Date().toISOString().slice(0, 10)
      jobs.push(
        d.repos.series
          .skipStaleOccurrences(todayISO)
          .then((changed) => {
            if (changed > 0) {
              d.logger.info({ changed }, 'recurrence sweep: skipped stale occurrences')
            }
          })
          .catch((err) => d.logger.error({ err }, 'recurrence sweep failed')),
      )
    }
    ctx.waitUntil(
      // allSettled so a future job pushed without its own .catch can't
      // reject the waitUntil promise; its rejection is logged below instead
      // of vanishing. Drain the warn+ log buffer — no per-request logFlush
      // middleware runs on the cron path, and a cron-only isolate may be
      // evicted before any HTTP request flushes it.
      Promise.allSettled(jobs)
        .then((results) => {
          for (const result of results) {
            if (result.status === 'rejected') {
              d.logger.error({ err: result.reason }, 'lists-worker: scheduled tick threw')
            }
          }
        })
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
export { ListsRPC } from './rpc.js'
