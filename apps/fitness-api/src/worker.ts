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
import type { EventsRPC } from '@rallypoint/events-api'
import type { AiRPC } from '@rallypoint/ai-api'
import type { AiTracesRpc } from '@rallypoint/ai'
import type { RateLimitCounterNamespace } from '@rallypoint/rate-limit'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'
import { buildLoggerWithFlush, type Logger } from './logger.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import { buildServices } from './services/index.js'
import { runNotificationTick } from './lib/notifications.js'
import type { Repos } from './repos/types.js'
import type { RestAlarmService, Services } from './services/types.js'

// Cloudflare Worker entrypoint for fitness-api. Bindings arrive per-request
// in `env`:
//   - DB     — the D1 database (passed to buildD1Repos)
//   - ASSETS — static-assets binding serving the fitness-web SPA for
//              non-/api paths; the Worker only handles /api/*
//              (wrangler.toml `assets.run_worker_first`).
//   - RPID   — typed RPC binding to id-api's IdRPC entrypoint (fitness's
//              catch-up to feat/rpc-bindings).
//   - RATE_LIMITS — the RateLimitCounter Durable Object namespace (#881):
//              one DO per token bucket, replacing the per-request D1 write
//              in the rate limiter.
//   - string vars/secrets (FITNESS_SESSION_KEY_V1, FITNESS_UI_ORIGIN, …)
//     that feed parseEnv.
//
// No realtime (HUB DO) — dropped vs. money-api intentionally. R2 arrived
// with progress pictures (OBJECT_STORE, optional). A `scheduled` handler
// (per-minute cron, wrangler.toml [triggers]) drains the rest-timer push
// queue via runNotificationTick as the safety net behind the REST_ALARMS
// Durable Object alarms.

interface AiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { gateway: { id: string } },
  ): Promise<{
    description?: string
    response?: string
    choices?: Array<{ message?: { content?: string } }>
  }>
}

export interface WorkerEnv {
  DB: D1Database
  ASSETS?: Fetcher
  // Typed RPC binding to id-api's IdRPC entrypoint (wrangler.toml
  // [[services]] + [[env.<env>.services]]: RPID -> IdRPC on
  // rallypoint-id{,-qa,-prod}).
  RPID?: Service<IdRPC>
  // Typed RPC binding to events-api's EventsRPC entrypoint — the
  // coordinate weather forecast (same Open-Meteo pipeline Planner's
  // My Day uses). Absent in single-app local dev → services.weather is
  // null and GET /api/v1/ui/weather 503s.
  EVENTS?: Service<EventsRPC>
  // Workers AI binding for the whiteboard-photo composer scan. Present
  // when the deployment opted into the Ink-redesign composer; absent →
  // services.vision is null and the route 502s with a friendly error.
  AI?: AiBinding
  // Private R2 bucket for Body Stats progress pictures. Absent →
  // services.objectStore is null and the progress-photo routes 503.
  OBJECT_STORE?: R2Bucket
  // RestTimerAlarm Durable Object namespace — on-time rest-timer push
  // delivery. Absent (tests) → services.restAlarms is null and delivery
  // rides the per-minute cron sweep alone.
  REST_ALARMS?: DurableObjectNamespace
  // The RateLimitCounter Durable Object namespace (#881) — one DO per
  // token bucket, replacing the per-request D1 write in the rate limiter.
  RATE_LIMITS: DurableObjectNamespace
  // Typed RPC binding to ai-api's AiRPC entrypoint — AI trace-corpus
  // ingest + feedback. Absent → scans run untraced.
  AI_TRACES?: Service<AiRPC>
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
  // RateLimitCounterNamespace (idFromName + get).
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
      ...(env.AI ? { ai: env.AI } : {}),
      ...(env.EVENTS ? { events: env.EVENTS } : {}),
      ...(env.OBJECT_STORE ? { objectStore: env.OBJECT_STORE } : {}),
      ...(env.REST_ALARMS ? { restAlarms: createRestAlarmService(env.REST_ALARMS) } : {}),
      // Service<AiRPC> is structurally the AiTracesRpc the services need
      // (async methods only) — the cast keeps @rallypoint/ai vendor-free.
      ...(env.AI_TRACES ? { aiTraces: env.AI_TRACES as unknown as AiTracesRpc } : {}),
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

  // Cron Trigger (wrangler.toml [triggers].crons, every minute) — sweep
  // any due rest-timer notifications whose DO alarm failed to fire.
  // deliverNotification atomically claims each row (sent_at CAS) before
  // sending, so an alarm racing the sweep — or overlapping ticks — sends
  // at most once; the loser counts as 'lost' in the tick result.
  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const d = ensureDeps(env)
    ctx.waitUntil(
      runNotificationTick(d.repos, d.services.webPush, new Date())
        .then(
          (result) => {
            if (result.due > 0) d.logger.info(result, 'notification tick')
          },
          (err: unknown) => d.logger.error({ err }, 'notification tick failed'),
        )
        // Drain the PostHog log-sink buffer after the tick so any warn+
        // records logged above (e.g. the failure branch) ship, mirroring
        // the per-request flush in middleware/log-flush.ts.
        .finally(() => d.flushLogs()),
    )
  },
}

// Adapter from the DO namespace binding to the RestAlarmService the push
// routes consume. One DO per (userId, dedupeKey) slot via idFromName.
function createRestAlarmService(ns: DurableObjectNamespace): RestAlarmService {
  const stub = (userId: string, dedupeKey: string) =>
    ns.get(ns.idFromName(`${userId}/${dedupeKey}`))
  return {
    async schedule(userId, dedupeKey, notificationId, fireAtMs) {
      await stub(userId, dedupeKey).fetch('https://do/schedule', {
        method: 'POST',
        body: JSON.stringify({ notificationId, fireAtMs }),
      })
    },
    async cancel(userId, dedupeKey) {
      await stub(userId, dedupeKey).fetch('https://do/cancel', { method: 'POST' })
    },
  }
}

// The RPC entrypoint must be exported from the Worker entry so wrangler
// can resolve consumers' `entrypoint = "FitnessRPC"` service bindings.
export { FitnessRPC } from './rpc.js'

// The Durable Object class must be exported from the Worker entry so
// wrangler can resolve the [[durable_objects.bindings]] class_name.
export { RestTimerAlarm } from './rest-timer-alarm.js'

// Same for the per-bucket rate-limit counter DO (#881): wrangler binds the
// RATE_LIMITS namespace to this export ([[durable_objects.bindings]] +
// [[migrations]] new_sqlite_classes).
export { RateLimitCounter } from '@rallypoint/rate-limit'
