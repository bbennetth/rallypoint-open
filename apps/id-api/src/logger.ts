import { createLogger, type Logger } from '@rallypoint/logger'
import type { Env } from './env.js'

// Structured logger for Rallypoint ID. Workers-safe (console JSON via
// @rallypoint/logger, which also carries the secret-redaction list);
// the `service` tag routes this service to its own stream downstream.
export function buildLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return createLogger({
    level: env.LOG_LEVEL,
    dev: env.NODE_ENV !== 'production',
    service: 'rallypoint-id',
  })
}

export type { Logger }
