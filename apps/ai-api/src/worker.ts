/// <reference types="@cloudflare/workers-types" />
import type {
  D1Database,
  ExecutionContext,
  R2Bucket,
  Service,
} from '@cloudflare/workers-types'
import { Hono } from 'hono'
import type { IdRPC } from '@rallypoint/id-api'
import { warmD1AndLog, isWarmTick } from '@rallypoint/api-kit'
import { parseEnv, type Env } from './env.js'
import { buildLoggerWithFlush, scheduleFlush, type Logger } from './logger.js'
import { createDb, createTracesRepo, type TracesRepo } from './repos/traces.js'
import { runDeletionSweep } from './services/deletion.js'
import { runRetentionDrain } from './services/retention.js'

// Cloudflare Worker entrypoint for ai-api — owner of the AI trace corpus
// (epic: own the AI usage data instead of relying on AI Gateway log
// retention). This Worker is NOT in the model-call path: apps call
// Workers AI directly and report traces here fire-and-forget via the
// AiRPC service binding (src/rpc.ts). The HTTP surface is /api/v1/health
// only (dev-stack health wait); everything else is RPC + cron.
//
// Bindings:
//   DB       — D1 (rp-ai-*), migrations in packages/ai-db/migrations
//   AI_STORE — R2 (rallypoint-ai-*): trace image blobs + JSONL exports
//   RPID     — Service<IdRPC>, used by the daily deletion sweep

export interface WorkerEnv {
  DB: D1Database
  AI_STORE: R2Bucket
  RPID?: Service<IdRPC>
  [key: string]: unknown
}

interface Deps {
  env: Env
  logger: Logger
  // Drains the buffered PostHog log records. Schedule via
  // `ctx.waitUntil` after each request / RPC call / cron tick so the
  // send survives the response.
  flushLogs: () => Promise<void>
  repos: { traces: TracesRepo }
}

let deps: Deps | null = null

export function ensureDeps(env: WorkerEnv): Deps {
  if (deps) return deps
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
    repos: { traces: createTracesRepo(createDb(env.DB)) },
  }
  return deps
}

const app = new Hono()
app.get('/api/v1/health', (c) => c.json({ ok: true, service: 'rallypoint-ai' }))

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const d = ensureDeps(env)
    try {
      return await app.fetch(request, env, ctx)
    } finally {
      scheduleFlush(ctx, d.flushLogs)
    }
  },

  // Daily cron: (1) deletion sweep — purge data for soft-deleted
  // accounts; (2) retention drain — archive old rows to JSONL in R2.
  // Both are idempotent, so an overlapping or retried tick is harmless.
  // The */5 cron is the D1 keep-warm ping only (isWarmTick dispatch).
  async scheduled(event: { cron?: string }, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const d = ensureDeps(env)
    ctx.waitUntil(
      (async () => {
        // Every tick pings D1 so the storage object never idle-evicts; the
        // sweep/drain only run on their own daily cron (a missing cron —
        // `wrangler dev --test-scheduled` with no ?cron= — still runs them
        // so local smoke keeps working).
        await warmD1AndLog(env.DB, d.logger)
        if (isWarmTick(event.cron)) return
        if (env.RPID) {
          const sweep = await runDeletionSweep(env.RPID, d.repos.traces, env.AI_STORE, d.logger)
          if (sweep.users > 0) d.logger.info(sweep, 'deletion sweep')
        } else {
          d.logger.warn('deletion sweep skipped: RPID binding missing')
        }
        const drain = await runRetentionDrain(
          d.repos.traces,
          env.AI_STORE,
          d.env.RETENTION_DAYS,
          new Date(),
          d.logger,
        )
        if (drain.drained > 0) d.logger.info(drain, 'retention drain')
      })()
        .catch((err: unknown) => d.logger.error({ err }, 'scheduled tick failed'))
        // Drain after the tick so the tick's own logs (including the
        // failure above) make it into the batch. flushLogs never rejects.
        .finally(() => d.flushLogs()),
    )
  },
}

export { AiRPC } from './rpc.js'
