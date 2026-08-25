import type { Context, MiddlewareHandler } from 'hono'
import { createRateLimit, createApplyPerUserRateLimit } from '@rallypoint/api-kit'
import type { RateLimitPolicy } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Per-route rate-limit. Shared implementation lives in @rallypoint/api-kit;
// this app supplies its daily-salt env key + error factory. Per-IP is the
// default (this middleware); per-user is applied in-route via
// applyPerUserRateLimit() once the session userId is known.

export type { RateLimitPolicy }

const config = {
  saltEnvKey: 'EVENTS_SESSION_KEY_V1',
  errors: { rateLimited: errors.rateLimited },
}

export function rateLimit(policy: RateLimitPolicy): MiddlewareHandler<HonoApp> {
  return createRateLimit(config)(policy) as MiddlewareHandler<HonoApp>
}

const applyPerUser = createApplyPerUserRateLimit(config)

export function applyPerUserRateLimit(
  c: Context<HonoApp>,
  args: { userId: string; route: string; limit: number; windowSeconds: number },
): Promise<void> {
  return applyPerUser(c, args)
}
