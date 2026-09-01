/// <reference types="@cloudflare/workers-types" />
import type {
  D1Database,
  DurableObjectNamespace,
  ExecutionContext,
  Fetcher,
  Service,
} from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { ListsRPC } from '@rallypoint/lists-api'
import type { EventsRPC } from '@rallypoint/events-api'
import type { FitnessRPC } from '@rallypoint/fitness-api'
import type { AiTracesRpc } from '@rallypoint/ai'
import { createEventCapture, type CaptureEvent } from '@rallypoint/logger'
import type { RateLimitCounterNamespace } from '@rallypoint/rate-limit'
import type { AiBinding } from './services/assist.js'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'
import { buildLoggerWithFlush, type Logger } from './logger.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import { buildServices } from './services/index.js'
import { runNotificationTick } from './lib/notifications.js'
import type { Repos } from './repos/types.js'
import type { Services } from './services/types.js'

// Cloudflare Worker entrypoint for planner-api (replaces the retired Node
// server.ts). Bindings arrive per-request in `env`:
//   - DB     — the D1 database (passed to buildD1Repos)
//   - ASSETS — static-assets binding serving the planner-web SPA for
//              non-/api paths; the Worker only handles /api/*
//              (wrangler.toml `assets.run_worker_first`), so we never call
//              ASSETS.fetch.
//   - RATE_LIMITS — the RateLimitCounter Durable Object namespace (#881):
//                    one DO per token bucket, replacing the per-request D1
//                    write in the rate limiter.
//   - string vars/secrets (PLANNER_SESSION_KEY_V1, PLANNER_UI_ORIGIN, …)
//     that feed parseEnv.
//
// planner is a BFF: it proxies lists/events/fitness/RPID via typed RPC
// bindings. It has NO realtime Durable Object and NO object store — the
// RATE_LIMITS binding above is the one Durable Object it does carry (#881),
// unrelated to realtime. As the owner of its own push notifications (each
// app owns its notifications), it also carries two infra tables
// (push_subscriptions, scheduled_notifications) and a `scheduled` cron
// handler that drains the notification queue — the documented exception to
// the otherwise fetch-only / no-domain-table BFF posture.

interface WorkerEnv {
  DB: D1Database
  RATE_LIMITS: DurableObjectNamespace
  ASSETS?: Fetcher
  // Typed RPC bindings to the same-account producers (PR 2 of
  // feat/rpc-bindings). The fetch-style fallback path is gone — services
  // call binding methods directly.
  RPID?: Service<IdRPC>
  LISTS?: Service<ListsRPC>
  EVENTS?: Service<EventsRPC>
  FITNESS?: Service<FitnessRPC>
  // AI Assist (routes/assist.ts): Workers AI binding + ai-api trace corpus.
  // Read off `c.env` in the route rather than the Services bag. Absent AI →
  // the assist route 503s; absent AI_TRACES → assist runs untraced.
  AI?: AiBinding
  AI_TRACES?: AiTracesRpc
  [key: string]: unknown
}

interface Deps {
  env: Env
  logger: Logger
  // Drains the PostHog log-sink buffer (info+ PostHog Logs forwarding).
  flushLogs: () => Promise<void>
  // Named-event capture for semantic push-delivery events. No-op when
  // POSTHOG_KEY is unset (dev/FOSS).
  captureEvent: CaptureEvent
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
  const { logger, flushLogs } = buildLoggerWithFlush(parsed)
  const captureEvent = createEventCapture({
    apiKey: parsed.POSTHOG_KEY,
    host: parsed.POSTHOG_HOST,
    service: 'rallypoint-planner',
  })
  // A real DurableObjectNamespace satisfies the structural
  // RateLimitCounterNamespace (idFromName + get).
  deps = {
    env: parsed,
    logger,
    flushLogs,
    captureEvent,
    repos: buildD1Repos(createDb(env.DB), env.RATE_LIMITS as unknown as RateLimitCounterNamespace),
    services: buildServices(parsed, {
      ...(env.RPID ? { rpid: env.RPID } : {}),
      ...(env.LISTS ? { lists: env.LISTS } : {}),
      ...(env.EVENTS ? { events: env.EVENTS } : {}),
      ...(env.FITNESS ? { fitness: env.FITNESS } : {}),
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

  // Cron Trigger (wrangler.toml [triggers].crons, every minute) — drain the
  // due push notifications and deliver them via Web Push. Racy-safe: each row
  // is atomically claimed (sent_at CAS) BEFORE its send, so when a slow tick
  // overruns the minute and the next tick starts, the second tick loses the
  // claim on any in-flight row and skips it — no double-send.
  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const d = ensureDeps(env)
    ctx.waitUntil(
      runNotificationTick(d.repos, d.services.webPush, new Date())
        .then(
          (result) => {
            const { events, ...summary } = result
            if (summary.due > 0) d.logger.info(summary, 'notification tick')
            // Per-user delivery outcomes → PostHog, attributed to the real
            // user (personProfile) so push health shows up in funnels.
            const sends = events.map((e) =>
              d.captureEvent(e.name, e.userId, e.properties, { personProfile: true }),
            )
            // Aggregate tick summary under the synthetic service person.
            if (summary.due > 0) {
              sends.push(d.captureEvent('notification_tick', 'server:rallypoint-planner', summary))
            }
            return Promise.all(sends).then(() => undefined)
          },
          (err: unknown) => {
            d.logger.error({ err }, 'notification tick failed')
          },
        )
        // Drain the warn+ log buffer for the cron path (no request middleware
        // runs here), plus the semantic events queued above.
        .finally(() => d.flushLogs()),
    )
  },
}

// The per-bucket rate-limit counter DO (#881): wrangler binds the
// RATE_LIMITS namespace to this export ([[durable_objects.bindings]] +
// [[migrations]] new_sqlite_classes).
export { RateLimitCounter } from '@rallypoint/rate-limit'
