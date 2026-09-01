/// <reference types="@cloudflare/workers-types" />
import type {
  D1Database,
  DurableObjectNamespace,
  ExecutionContext,
  Fetcher,
  R2Bucket,
  Service,
} from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import {
  createDoRealtimeBus,
  type RealtimeBus,
  type RealtimeHubNamespace,
} from '@rallypoint/realtime'
import type { RateLimitCounterNamespace } from '@rallypoint/rate-limit'
import { warmD1AndLog } from '@rallypoint/api-kit'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'
import { buildLoggerWithFlush, type Logger } from './logger.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import { buildServices } from './services/index.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'

// Cloudflare Worker entrypoint for money-api (replaces the retired Node
// server.ts). Bindings arrive per-request in `env`:
//   - DB           — the D1 database (passed to buildD1Repos)
//   - HUB          — the RealtimeHub Durable Object namespace. The publish
//                    side (createDoRealtimeBus) resolves a channel DO and
//                    POSTs the pointer envelope; the WS-upgrade route
//                    (routes/realtime.ts) forwards the socket to the channel
//                    DO via c.var.hub.
//   - RATE_LIMITS  — the RateLimitCounter Durable Object namespace (#881):
//                    one DO per token bucket, replacing the per-request D1
//                    write in the rate limiter.
//   - OBJECT_STORE — R2 bucket for receipt images (#409). Native binding,
//                    private bucket, bytes stream through the Worker.
//   - ASSETS       — static-assets binding serving the money-web SPA for
//                    non-/api paths; the Worker only handles /api/*
//                    (wrangler.toml `assets.run_worker_first`).
//   - string vars/secrets (MONEY_API_KEY, MONEY_SESSION_KEY_V1,
//     REALTIME_TOKEN_HMAC_KEY, MONEY_UI_ORIGIN, RPID_API_URL, …) that
//     feed parseEnv.
//
// money has no background pruner; its `scheduled` handler is only the
// D1 keep-warm ping (wrangler.toml [triggers], every 5 minutes) that
// stops the storage object idle-evicting between requests.

export interface WorkerEnv {
  DB: D1Database
  HUB: DurableObjectNamespace
  RATE_LIMITS: DurableObjectNamespace
  // R2 bucket binding for receipt object storage (#409).
  OBJECT_STORE: R2Bucket
  ASSETS?: Fetcher
  // Typed RPC binding to id-api's IdRPC entrypoint (PR 2 of feat/rpc-bindings).
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
  deps = {
    env: parsed,
    logger,
    flushLogs,
    repos: buildD1Repos(createDb(env.DB), env.RATE_LIMITS as unknown as RateLimitCounterNamespace),
    services: buildServices(parsed, {
      objectStore: env.OBJECT_STORE,
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
export { MoneyRPC } from './rpc.js'
