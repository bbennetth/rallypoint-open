import type { MiddlewareHandler } from 'hono'
import type { HonoApp } from '../context.js'
import { extractIp, dailySalt, hashIp } from '@rallypoint/crypto'
import { TENANT_DEFAULT } from '@rallypoint/shared'
import { errors } from '../errors.js'

// Per-route rate-limit middleware. Extracts the IP-based bucket key,
// calls into the rate-limit repo, and 429s if the bucket is exhausted.
// The repo handles atomic increments.

export interface RateLimitPolicy {
  route: string // short slug for the bucket key
  perIp: { limit: number; windowSeconds: number }
}

export function rateLimit(policy: RateLimitPolicy): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    const env = c.var.env
    const ip = extractIp({ headers: c.req.raw.headers, policy: env.TRUSTED_PROXY_HEADER })
    const salt = dailySalt(env.LISTS_SESSION_KEY_V1)
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
