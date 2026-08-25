import {
  consoleSink,
  createLogger,
  createPostHogLogSink,
  teeSink,
  type Logger,
} from '@rallypoint/logger'
import type { Env } from './env.js'

const SERVICE = 'rallypoint-ai'

// Env fields the logger needs: level/mode plus the PostHog forwarding
// config (POSTHOG_KEY/HOST, unset in dev/FOSS → the log sink is a no-op).
type LoggerEnv = Pick<
  Env,
  'LOG_LEVEL' | 'NODE_ENV' | 'POSTHOG_KEY' | 'POSTHOG_HOST' | 'DEPLOY_ENV'
>

// Structured logger for ai-api. Workers-safe (console JSON via
// @rallypoint/logger); the `service` tag routes this service to its own
// stream downstream. In prod/QA it also tees every info+ record to the
// PostHog Logs product as an OTLP log record (full server-side
// visibility); `flushLogs` drains that buffer and must be scheduled via
// `executionCtx.waitUntil` after each request/RPC call/tick.
export function buildLoggerWithFlush(env: LoggerEnv): {
  logger: Logger
  flushLogs: () => Promise<void>
} {
  const logSink = createPostHogLogSink({
    apiKey: env.POSTHOG_KEY,
    host: env.POSTHOG_HOST,
    service: SERVICE,
    environment: env.DEPLOY_ENV,
  })
  const logger = createLogger({
    level: env.LOG_LEVEL,
    dev: env.NODE_ENV !== 'production',
    service: SERVICE,
    sink: teeSink(consoleSink, logSink.sink),
  })
  return { logger, flushLogs: logSink.flush }
}

/** Schedule a log-drain that survives the response. Mirrors the guarded
 *  `executionCtx.waitUntil` in the other apps' logFlush middleware: a
 *  missing/!invalid execution context must not throw, because every call
 *  site here sits in a `finally` where a throw would mask the real
 *  return value or error. */
export function scheduleFlush(
  ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
  flush: () => Promise<void>,
): void {
  // Start the flush BEFORE touching ctx: `ctx?.waitUntil(flush())` would
  // short-circuit the whole expression when ctx is absent, silently
  // dropping the batch instead of merely failing to extend its lifetime.
  const pending = flush().catch(() => {})
  try {
    ctx?.waitUntil(pending)
  } catch {
    // No usable execution context (some test harnesses). The flush is
    // already in flight; it just isn't lifetime-extended.
  }
}

// Back-compat shim for callers that only need the logger.
export function buildLogger(env: LoggerEnv): Logger {
  return buildLoggerWithFlush(env).logger
}

export type { Logger }
