import type { Context, MiddlewareHandler } from 'hono'
import {
  createRateLimit,
  createApplyPerUserRateLimit,
  createRateLimitBucket,
} from '@rallypoint/api-kit'
import type { IpRateLimitPolicy } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { hashIp } from '../crypto/ip-hash.js'
import { normalizeEmail } from '../lib/normalize-email.js'
import { errors } from '../errors.js'

// Per-route rate-limit. Shared implementation lives in @rallypoint/api-kit;
// this app supplies its daily-salt env key + error factory. id-api's salt is
// ARGON2_PEPPER (it has no <APP>_SESSION_KEY_V1).
//   - Per-IP buckets are the default (this middleware).
//   - Per-user buckets (applyPerUserRateLimit) kick in inside handlers that
//     have already authenticated the user via requireSession.
//   - Per-email buckets (applyPerEmailRateLimit) kick in inside the pre-auth
//     handlers (signin/start, password-reset/request, signup) that carry an
//     email but no session.

// This middleware is the per-IP path (per-user/per-email buckets go through
// the apply* helpers below), so the shared IP-narrowed policy applies:
// omitting perIp would silently no-op the bucket instead of failing to build.
export type RateLimitPolicy = IpRateLimitPolicy

// onStoreError: 'deny' — id-api's surface is almost entirely abuse-facing
// (signin, signup, password reset, 2FA resend), so a transient rate-limit
// store failure must NOT quietly drop brute-force protection. Set once at the
// app level rather than per route, so routes added later inherit the safe
// behaviour instead of defaulting to fail-open. Callers still get a 429 with
// a short Retry-After, never a 500.
const config = {
  saltEnvKey: 'ARGON2_PEPPER',
  errors: { rateLimited: errors.rateLimited },
  onStoreError: 'deny' as const,
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

// Per-EMAIL rate limit for pre-auth endpoints. The bucket key hashes the
// *normalized* email with the server pepper — NOT dailySalt(), which rotates
// at UTC midnight and would reset the window mid-attack. sha256(pepper|email)
// keeps raw email out of the rate_limits.bucket_key column while collapsing
// casing/whitespace variants of one address onto one bucket. Hashing stays
// local (id-specific pepper + normalization); only the take-token/429 tail is
// shared via createRateLimitBucket.
const emailBucket = createRateLimitBucket(config)

export async function applyPerEmailRateLimit(
  c: Context<HonoApp>,
  args: { email: string; route: string; limit: number; windowSeconds: number },
): Promise<void> {
  const emailHash = hashIp(normalizeEmail(args.email), c.var.env.ARGON2_PEPPER)
  await emailBucket(c, {
    bucketKey: `email:${emailHash}:${args.route}`,
    tag: `email:${args.route}`,
    limit: args.limit,
    windowSeconds: args.windowSeconds,
  })
}
