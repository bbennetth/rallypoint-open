import type { MiddlewareHandler } from 'hono'
import type { HonoApp } from '../context.js'
import { extractIp, dailySalt, hashIp } from '@rallypoint/crypto'
import { TENANT_DEFAULT } from '@rallypoint/shared'
import { errors } from '../errors.js'

// Per-route IP rate-limit middleware for money-api.
// Mirrors apps/id-api/src/middleware/rate-limit.ts.
//
// V1 policy: per-IP buckets only. The tenant is hard-coded to
// 'rallypoint' (single-tenant V1, matches the schema default).
// Bucket key: `ip:<hash>:<route-slug>`.

export interface RateLimitPolicy {
  route: string // short slug included in the bucket key
  perIp: { limit: number; windowSeconds: number }
}

export function rateLimit(policy: RateLimitPolicy): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    const ip = extractIp({ headers: c.req.raw.headers, policy: c.var.env.TRUSTED_PROXY_HEADER })
    const salt = dailySalt(c.var.env.MONEY_SESSION_KEY_V1)
    const ipHash = hashIp(ip, salt)
    const bucketKey = `ip:${ipHash}:${policy.route}`

    const decision = await c.var.repos.rateLimit.takeToken({
      tenantId: TENANT_DEFAULT,
      bucketKey,
      limit: policy.perIp.limit,
      windowSeconds: policy.perIp.windowSeconds,
    })

    if (!decision.allowed) {
      c.header('Retry-After', String(decision.retryAfterSeconds))
      throw errors.rateLimited(decision.retryAfterSeconds, `ip:${policy.route}`)
    }

    await next()
  }
}
