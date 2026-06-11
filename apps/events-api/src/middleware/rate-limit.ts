import type { Context, MiddlewareHandler } from 'hono'
import type { HonoApp } from '../context.js'
import { dailySalt, hashIp, extractIp } from '@rallypoint/crypto'
import { TENANT_DEFAULT } from '@rallypoint/shared'
import { errors } from '../errors.js'

// Per-route rate-limit middleware for events-api. Mirrors
// apps/id-api/src/middleware/rate-limit.ts — same interface, same bucket-key
// convention, same 429 + Retry-After shape. Per-IP policy uses the salted IP
// hash from @rallypoint/crypto (matching how sso.ts already hashes IPs for
// the session row). Per-user policy is applied in-route via
// applyPerUserRateLimit() once the session userId is known.
//
// V1 single-tenant: all buckets use 'rallypoint'.

export interface RateLimitPolicy {
  route: string // short slug for the bucket key
  perIp?: { limit: number; windowSeconds: number }
  perUser?: { limit: number; windowSeconds: number }
}

export function rateLimit(policy: RateLimitPolicy): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    const ipPolicy = policy.perIp
    if (ipPolicy) {
      const ip = extractIp({ headers: c.req.raw.headers, policy: c.var.env.TRUSTED_PROXY_HEADER })
      const salt = dailySalt(c.var.env.EVENTS_SESSION_KEY_V1)
      const ipHash = hashIp(ip, salt)
      const bucketKey = `ip:${ipHash}:${policy.route}`
      const decision = await c.var.repos.rateLimit.takeToken({
        tenantId: tenant(c),
        bucketKey,
        limit: ipPolicy.limit,
        windowSeconds: ipPolicy.windowSeconds,
      })
      if (!decision.allowed) {
        c.header('Retry-After', String(decision.retryAfterSeconds))
        throw errors.rateLimited(decision.retryAfterSeconds, `ip:${policy.route}`)
      }
    }
    // perUser is applied in the handler once the session is attached;
    // routes that need it call applyPerUserRateLimit() directly.
    await next()
  }
}

export async function applyPerUserRateLimit(
  c: Context<HonoApp>,
  args: { userId: string; route: string; limit: number; windowSeconds: number },
): Promise<void> {
  const bucketKey = `user:${args.userId}:${args.route}`
  const decision = await c.var.repos.rateLimit.takeToken({
    tenantId: tenant(c),
    bucketKey,
    limit: args.limit,
    windowSeconds: args.windowSeconds,
  })
  if (!decision.allowed) {
    c.header('Retry-After', String(decision.retryAfterSeconds))
    throw errors.rateLimited(decision.retryAfterSeconds, `user:${args.route}`)
  }
}

function tenant(_c: Context<HonoApp>): string {
  return TENANT_DEFAULT
}
