import type { MiddlewareHandler } from 'hono'
import { createSessionMiddleware } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { decryptBearer } from '../crypto/encryption.js'

export const PLANNER_SESSION_BEARER_PREFIX = 'rpp_sess_'

export function requireSession(): MiddlewareHandler<HonoApp> {
  return createSessionMiddleware({
    bearerPrefix: PLANNER_SESSION_BEARER_PREFIX,
    cookieNameEnvKey: 'PLANNER_SESSION_COOKIE_NAME',
    decryptBearer,
    errors: {
      unauthorized: () => errors.unauthorized(),
      upstreamUnavailable: () => errors.upstreamUnavailable(),
    },
    grace: { ttlHoursEnvKey: 'SESSION_OFFLINE_TTL_HOURS' },
  }) as MiddlewareHandler<HonoApp>
}
