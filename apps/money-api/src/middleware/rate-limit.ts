import type { MiddlewareHandler } from 'hono'
import { createRateLimit } from '@rallypoint/api-kit'
import type { IpRateLimitPolicy } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Per-route IP rate-limit. Shared implementation lives in @rallypoint/api-kit;
// this app supplies its daily-salt env key + error factory. V1 policy:
// per-IP buckets only.

// Per-IP only, so the shared IP-narrowed policy applies (perIp required).
export type RateLimitPolicy = IpRateLimitPolicy

const rl = createRateLimit({
  saltEnvKey: 'MONEY_SESSION_KEY_V1',
  errors: { rateLimited: errors.rateLimited },
})

export function rateLimit(policy: RateLimitPolicy): MiddlewareHandler<HonoApp> {
  return rl(policy) as MiddlewareHandler<HonoApp>
}
