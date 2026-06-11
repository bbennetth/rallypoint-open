import type { Context, MiddlewareHandler } from 'hono'
import type { HonoApp } from '../context.js'
import { extractIp, dailySalt, hashIp } from '@rallypoint/crypto'
import { TENANT_DEFAULT } from '@rallypoint/shared'
import { errors } from '../errors.js'

// Per-route rate-limit middleware for planner-api. Mirrors the pattern from
// apps/id-api/src/middleware/rate-limit.ts with planner-specific env vars.
//
// V1 policy:
//   - Per-IP: used for public/SSO routes (POST /sso/exchange).
//     Bucket key = `ip:<hashIp>:<route>` using a daily-salted hash with
//     PLANNER_SESSION_KEY_V1 as the secret (same key used for ip_hash in
//     session rows — consistent across the app).
//   - Per-user: used for authenticated BFF routes (GET /my-day, /upcoming).
//     Applied via applyPerUserRateLimit() inside the handler after requireSession
//     sets session.userId.
//
// Tenant: always 'rallypoint' (V1 single-tenant). Phase C resolves from
// subdomain/OIDC. This matches id-api's approach exactly.

export interface RateLimitPolicy {
  route: string
  perIp?: { limit: number; windowSeconds: number }
}

export function rateLimit(policy: RateLimitPolicy): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    const ipPolicy = policy.perIp
    if (ipPolicy) {
      const ip = extractIp({
        headers: c.req.raw.headers,
        policy: c.var.env.TRUSTED_PROXY_HEADER,
      })
      const salt = dailySalt(c.var.env.PLANNER_SESSION_KEY_V1)
      const ipHash = hashIp(ip, salt)
      const bucketKey = `ip:${ipHash}:${policy.route}`
      const decision = await c.var.repos.rateLimit.takeToken({
        tenantId: TENANT_DEFAULT,
        bucketKey,
        limit: ipPolicy.limit,
        windowSeconds: ipPolicy.windowSeconds,
      })
      if (!decision.allowed) {
        c.header('Retry-After', String(decision.retryAfterSeconds))
        throw errors.rateLimited(decision.retryAfterSeconds, `ip:${policy.route}`)
      }
    }
    await next()
  }
}

export async function applyPerUserRateLimit(
  c: Context<HonoApp>,
  args: { userId: string; route: string; limit: number; windowSeconds: number },
): Promise<void> {
  const bucketKey = `user:${args.userId}:${args.route}`
  const decision = await c.var.repos.rateLimit.takeToken({
    tenantId: TENANT_DEFAULT,
    bucketKey,
    limit: args.limit,
    windowSeconds: args.windowSeconds,
  })
  if (!decision.allowed) {
    c.header('Retry-After', String(decision.retryAfterSeconds))
    throw errors.rateLimited(decision.retryAfterSeconds, `user:${args.route}`)
  }
}
