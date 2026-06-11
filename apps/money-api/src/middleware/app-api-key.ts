import type { MiddlewareHandler } from 'hono'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { constantTimeEqual } from '@rallypoint/crypto'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'

// App-API-key bearer gate for the /api/v1/sdk/* endpoints peer apps
// call server-to-server. events-api presents its EVENTS_API_KEY;
// money-api validates it against this. Same anti-fingerprint posture
// as the lists gate: no keys configured → 404, wrong/absent → 403.
export const requireSdkKey: MiddlewareHandler<HonoApp> = async (c, next) => {
  const keys = [c.var.env.EVENTS_API_KEY].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  )
  if (keys.length === 0) {
    throw new ApiError({ ...ANTI_FINGERPRINT_NOT_FOUND, status: 404 })
  }
  const header = c.req.header('authorization') ?? ''
  const supplied = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  let matched = false
  for (const key of keys) {
    if (constantTimeEqual(supplied, key)) matched = true
  }
  if (!matched) throw errors.forbidden('App API authentication required.')
  await next()
}
