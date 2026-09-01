import type { Context, MiddlewareHandler } from 'hono'
import { extractIp, dailySalt, hashIp, type TrustPolicy } from '@rallypoint/crypto'
import { TENANT_DEFAULT } from '@rallypoint/shared'
import { RateLimitStoreUnavailableError, type RateLimitRepo } from '@rallypoint/rate-limit'
import { errorCauseChain } from '@rallypoint/logger'
import { isTransientD1Error } from './d1-retry.js'
import type { ApiKitLogger } from './session.js'

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

/**
 * What to do when the rate-limit store itself fails transiently (a D1 storage
 * blip), as opposed to the bucket being exhausted.
 *
 * - `'allow'` (default): let the request through unlimited. Right for ordinary
 *   product routes, where a few seconds of unlimited polling is harmless and a
 *   hard failure would surface as a user-facing error.
 * - `'deny'`: reject with the normal 429 + Retry-After. Right for abuse-facing
 *   routes (signin, signup, password reset, SSO code exchange), where dropping
 *   the limiter is a brute-force window. Still not a 500 — clients see a
 *   retryable "back off briefly", which is the honest answer when we can't
 *   account for the request.
 */
export type RateLimitStoreErrorMode = 'allow' | 'deny'

/**
 * Retry-After (seconds) sent when a `'deny'` bucket rejects because the store
 * is unavailable. Deliberately short and unrelated to the bucket's window: the
 * caller isn't over quota, we just can't count right now, and D1 storage
 * resets resolve in seconds.
 */
export const STORE_ERROR_RETRY_AFTER_SECONDS = 5

export interface RateLimitPolicy {
  /** Short slug included in the bucket key. */
  route: string
  /** Optional so apps that never rate-limit by IP can omit it entirely. */
  perIp?: { limit: number; windowSeconds: number }
  /** Per-route override of the app-level {@link RateLimitErrorsConfig.onStoreError}. */
  onStoreError?: RateLimitStoreErrorMode
}

/**
 * A policy for an app whose `rateLimit()` middleware is per-IP only — i.e.
 * every app except where a per-user/per-email bucket is applied inside the
 * handler instead. `perIp` is narrowed back to REQUIRED: `createRateLimit`
 * silently no-ops the whole bucket when it is absent, so a route that forgets
 * it ships completely unlimited rather than failing to compile.
 *
 * Defined here rather than in each app so the narrowing lives in one place and
 * apps still inherit new shared fields (e.g. `onStoreError`) automatically.
 */
export type IpRateLimitPolicy = RateLimitPolicy & {
  perIp: NonNullable<RateLimitPolicy['perIp']>
}

export interface RateLimitErrorsConfig {
  /** App error factory — thrown so the app's error handler formats it. */
  errors: { rateLimited(retryAfterSeconds: number, bucket: string): Error }
  /** Tenant id for bucket rows. Defaults to `TENANT_DEFAULT` ('rallypoint'). */
  tenant?: string
  /**
   * App-wide default for transient store failures. Defaults to `'allow'`.
   * An app whose surface is mostly abuse-facing (id-api) sets `'deny'` here
   * once so every current *and future* route inherits the safe behaviour;
   * apps with one such route override it per-policy instead.
   */
  onStoreError?: RateLimitStoreErrorMode
}

export interface RateLimitMiddlewareConfig extends RateLimitErrorsConfig {
  /** Env key holding the daily-salt secret, e.g. `'EVENTS_SESSION_KEY_V1'`
   *  (id-api uses `'ARGON2_PEPPER'`). */
  saltEnvKey: string
}

interface RateLimitCtxVars {
  env: Record<string, unknown>
  repos: { rateLimit: RateLimitRepo }
  logger?: ApiKitLogger
}

// Shared take-token/429/Retry-After tail over an already-built bucket key +
// error tag. Used by the per-IP and per-user helpers, and exported so apps
// with a bespoke bucket key (id-api's per-email hash) can reuse the tail
// without api-kit modelling their hashing strategy.
export function createRateLimitBucket(config: RateLimitErrorsConfig) {
  return async (
    c: Context,
    args: {
      bucketKey: string
      tag: string
      limit: number
      windowSeconds: number
      onStoreError?: RateLimitStoreErrorMode | undefined
    },
  ): Promise<void> => {
    const vars = c.var as unknown as RateLimitCtxVars
    // takeToken WRITES to D1 on every rate-limited request, so when D1's
    // storage object is momentarily reset (the production write-storm
    // signature) an un-caught throw turns a limiter blip into a 500 on every
    // guarded route. Neither outcome should be a 500: ordinary routes fail
    // open (unlimited for the few seconds it lasts), abuse-facing routes fail
    // closed with the normal 429. Deterministic errors (SQL bugs) still
    // surface — a permanently broken limiter must not silently stop limiting.
    let decision
    try {
      decision = await vars.repos.rateLimit.takeToken({
        tenantId: config.tenant ?? TENANT_DEFAULT,
        bucketKey: args.bucketKey,
        limit: args.limit,
        windowSeconds: args.windowSeconds,
      })
    } catch (err) {
      // Two transient shapes, one policy: a D1 storage blip (the D1-backed
      // repo) or a DO round-trip failure the DO-backed repo already retried
      // once (it wraps those in RateLimitStoreUnavailableError — see
      // packages/rate-limit/src/do-repo.ts). Everything else is a bug and
      // must surface.
      if (!isTransientD1Error(err) && !(err instanceof RateLimitStoreUnavailableError)) {
        throw err
      }
      const mode = args.onStoreError ?? config.onStoreError ?? 'allow'
      // Lift the cause chain to its own field: drizzle's outer message is a
      // generic "Failed query: …", and `.cause` is non-enumerable so the
      // shared logger's Error clone drops it — losing the one text that says
      // WHICH transient condition fired. errorCauseChain is the same walker
      // the error handler uses for this error family.
      vars.logger?.warn(
        {
          err,
          causes: errorCauseChain(err),
          bucket: args.tag,
          mode,
        },
        mode === 'deny'
          ? 'rate-limit store unavailable (transient); denying request (429)'
          : 'rate-limit store unavailable (transient); allowing request unlimited',
      )
      if (mode === 'deny') {
        c.header('Retry-After', String(STORE_ERROR_RETRY_AFTER_SECONDS))
        throw config.errors.rateLimited(STORE_ERROR_RETRY_AFTER_SECONDS, args.tag)
      }
      return
    }
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
          onStoreError: policy.onStoreError,
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
    args: {
      userId: string
      route: string
      limit: number
      windowSeconds: number
      onStoreError?: RateLimitStoreErrorMode | undefined
    },
  ): Promise<void> =>
    bucket(c, {
      bucketKey: `user:${args.userId}:${args.route}`,
      tag: `user:${args.route}`,
      limit: args.limit,
      windowSeconds: args.windowSeconds,
      onStoreError: args.onStoreError,
    })
}
