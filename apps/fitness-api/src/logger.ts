import {
  consoleSink,
  createLogger,
  createPostHogLogSink,
  teeSink,
  type Logger,
} from '@rallypoint/logger'
import type { Env } from './env.js'

const SERVICE = 'rallypoint-fitness'

type LoggerEnv = Pick<
  Env,
  'LOG_LEVEL' | 'NODE_ENV' | 'POSTHOG_KEY' | 'POSTHOG_HOST' | 'DEPLOY_ENV'
>

// Structured logger for Rallypoint Fitness. Workers-safe (console JSON via
// @rallypoint/logger, which also carries the secret-redaction list); the
// `service` tag routes this service to its own stream downstream. In
// prod/QA it also tees every info+ record to the PostHog Logs product as
// an OTLP log record (full server-side visibility); `flushLogs` drains
// that buffer and must be scheduled via `executionCtx.waitUntil` after
// each request/tick.
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

export function buildLogger(env: LoggerEnv): Logger {
  return buildLoggerWithFlush(env).logger
}

export type { Logger }
