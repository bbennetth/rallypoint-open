import type { MiddlewareHandler } from 'hono'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { constantTimeEqual } from '@rallypoint/crypto'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'

// App-API-key bearer gate for the /api/v1/sdk/personal-events/* endpoints
// that the Planner BFF calls server-to-server. The Planner BFF presents
// PLANNER_API_KEY as its Bearer; events-api accepts it here.
//
// Anti-fingerprint posture (mirrors lists-api's gate and RPID's gate):
//   • No keys configured at all → 404 (route does not exist on this deployment)
//   • Wrong / absent Bearer    → 403
//   • Constant-time compare on the match
export const requireSdkKey: MiddlewareHandler<HonoApp> = async (c, next) => {
  const keys = [c.var.env.PLANNER_API_KEY].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  )
  if (keys.length === 0) {
    throw new ApiError({ ...ANTI_FINGERPRINT_NOT_FOUND, status: 404 })
  }
  const header = c.req.header('authorization') ?? ''
  const supplied = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  // Compare against every configured key with no early-return on match, so a
  // match's position in the pool isn't observable. constantTimeEqual is
  // content-constant-time but returns false on a length mismatch, so the
  // configured key's *length* is still inferable by timing — an accepted
  // tradeoff shared with RPID's gate; the secret bytes never leak.
  let matched = false
  for (const key of keys) {
    if (constantTimeEqual(supplied, key)) matched = true
  }
  if (!matched) throw errors.forbidden('App API authentication required.')
  await next()
}
