import type { Context, MiddlewareHandler } from 'hono'
import { extractIp, dailySalt, hashIp, type TrustPolicy } from '@rallypoint/crypto'
import { TENANT_DEFAULT } from '@rallypoint/shared'
import type { RateLimitRepo } from '@rallypoint/rate-limit'

// Per-route rate-limit middleware. Figures out the bucket key, calls the
// rate-limit repo's atomic takeToken, and 429s (with Retry-After) when a
// bucket is exhausted. Copy-pasted across the HTTP APIs — same interface,
// same bucket-key convention, same 429 shape — differing only by the salt
// env var; it lives here once now.
//
// The per-IP bucket hashes the salted IP with dailySalt(env[saltEnvKey]).
// id-api's per-EMAIL bucket deliberately uses a *static* pepper (no daily
// rotation, which would reset the window mid-attack), so that hashing stays
// app-local and only the take-token/429 tail is shared via createRateLimitBucket.

export interface RateLimitPolicy {
  /** Short slug included in the bucket key. */
  route: string
  /** Optional so apps that never rate-limit by IP can omit it entirely. */
  perIp?: { limit: number; windowSeconds: number }
}

export interface RateLimitErrorsConfig {
  /** App error factory — thrown so the app's error handler formats it. */
  errors: { rateLimited(retryAfterSeconds: number, bucket: string): Error }
  /** Tenant id for bucket rows. Defaults to `TENANT_DEFAULT` ('rallypoint'). */
  tenant?: string
}

export interface RateLimitMiddlewareConfig extends RateLimitErrorsConfig {
  /** Env key holding the daily-salt secret, e.g. `'EVENTS_SESSION_KEY_V1'`
   *  (id-api uses `'ARGON2_PEPPER'`). */
  saltEnvKey: string
}

interface RateLimitCtxVars {
  env: Record<string, unknown>
  repos: { rateLimit: RateLimitRepo }
}

// Shared take-token/429/Retry-After tail over an already-built bucket key +
// error tag. Used by the per-IP and per-user helpers, and exported so apps
// with a bespoke bucket key (id-api's per-email hash) can reuse the tail
// without api-kit modelling their hashing strategy.
export function createRateLimitBucket(config: RateLimitErrorsConfig) {
  return async (
    c: Context,
    args: { bucketKey: string; tag: string; limit: number; windowSeconds: number },
  ): Promise<void> => {
    const vars = c.var as unknown as RateLimitCtxVars
    const decision = await vars.repos.rateLimit.takeToken({
      tenantId: config.tenant ?? TENANT_DEFAULT,
      bucketKey: args.bucketKey,
      limit: args.limit,
      windowSeconds: args.windowSeconds,
    })
    if (!decision.allowed) {
      c.header('Retry-After', String(decision.retryAfterSeconds))
      throw config.errors.rateLimited(decision.retryAfterSeconds, args.tag)
    }
  }
}

export function createRateLimit(config: RateLimitMiddlewareConfig) {
  const bucket = createRateLimitBucket(config)
  return (policy: RateLimitPolicy): MiddlewareHandler => {
    return async (c, next) => {
      const ipPolicy = policy.perIp
      if (ipPolicy) {
        const vars = c.var as unknown as RateLimitCtxVars
        const ip = extractIp({
          headers: c.req.raw.headers,
          // Every consumer app's env schema types TRUSTED_PROXY_HEADER as a
          // TrustPolicy (with a default); extractIp also tolerates undefined
          // (falls back to 'legacy'), so this cast never widens behavior.
          policy: vars.env.TRUSTED_PROXY_HEADER as TrustPolicy,
        })
        const salt = dailySalt(String(vars.env[config.saltEnvKey]))
        const ipHash = hashIp(ip, salt)
        await bucket(c, {
          bucketKey: `ip:${ipHash}:${policy.route}`,
          tag: `ip:${policy.route}`,
          limit: ipPolicy.limit,
          windowSeconds: ipPolicy.windowSeconds,
        })
      }
      // perUser is applied in the handler once the session is attached;
      // routes that need it call the per-user helper directly.
      await next()
    }
  }
}

// Per-user token bucket, applied inside a session-gated handler once
// session.userId is known. Throws a 429 (with Retry-After) when exhausted.
export function createApplyPerUserRateLimit(config: RateLimitErrorsConfig) {
  const bucket = createRateLimitBucket(config)
  return (
    c: Context,
    args: { userId: string; route: string; limit: number; windowSeconds: number },
  ): Promise<void> =>
    bucket(c, {
      bucketKey: `user:${args.userId}:${args.route}`,
      tag: `user:${args.route}`,
      limit: args.limit,
      windowSeconds: args.windowSeconds,
    })
}
