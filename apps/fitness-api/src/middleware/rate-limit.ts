import type { Context, MiddlewareHandler } from 'hono'
import { createRateLimit, createApplyPerUserRateLimit } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Per-route rate-limit. Shared implementation lives in @rallypoint/api-kit;
// this app supplies its daily-salt env key + error factory.
//   - Per-IP: `rateLimit()` middleware, bucket key `ip:<hash>:<route-slug>`.
//   - Per-user: `applyPerUserRateLimit()` inside session-gated handlers.

export interface RateLimitPolicy {
  route: string // short slug included in the bucket key
  perIp: { limit: number; windowSeconds: number }
}

// Shared per-user policy for the Workers AI vision endpoints (food
// scan/text/label + WOD scan). One bucket across all four so a user can't
// get 4× the budget by rotating endpoints — they all draw on the same
// Workers AI capacity. Exported so routes/food.ts and routes/scan.ts stay
// in lockstep on the key and limit.
export const AI_SCAN_RATE_LIMIT = { route: 'ai-scan', limit: 10, windowSeconds: 60 } as const

const config = {
  saltEnvKey: 'FITNESS_SESSION_KEY_V1',
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
