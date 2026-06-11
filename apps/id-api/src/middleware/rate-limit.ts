import type { Context, MiddlewareHandler } from 'hono'
import type { HonoApp } from '../context.js'
import { dailySalt, hashIp } from '../crypto/ip-hash.js'
import { errors } from '../errors.js'
import { extractIpFromContext } from '../http/extract-ip.js'

// Per-route rate-limit middleware. The middleware figures out the
// IP-based bucket key and (optionally) a per-user bucket key,
// calls into the rate-limit repo for each, and 429s if any
// bucket is exhausted. The repo handles atomic increments.
//
// V1 default policy (slice 2.5 documentation):
//   - per-IP buckets are the default
//   - per-user buckets only kick in when the handler upstream has
//     already authenticated the user (slice 3a)
//   - we don't apply rate-limit to GET /health or /api/v1/version

export interface RateLimitPolicy {
  route: string // short slug for the bucket key
  perIp?: { limit: number; windowSeconds: number }
  // perUser entries are applied by middleware in routes that have
  // session-authenticated users (Slice 3a-onwards)
  perUser?: { limit: number; windowSeconds: number }
}

export function rateLimit(policy: RateLimitPolicy): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    const ipPolicy = policy.perIp
    if (ipPolicy) {
      const ip = extractIpFromContext(c)
      const salt = dailySalt(c.var.env.ARGON2_PEPPER)
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
    // perUser is applied in the handler once session is attached;
    // V1 routes that need it call applyPerUserRateLimit() directly.
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
  // V1 single-tenant default. Phase C resolves tenant from
  // sub-domain / OIDC claim / etc.
  return 'rallypoint'
}
