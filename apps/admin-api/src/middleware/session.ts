import type { MiddlewareHandler } from 'hono'
import { createSessionMiddleware } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { decryptBearer } from '../crypto/encryption.js'

export const ADMIN_SESSION_BEARER_PREFIX = 'rpa_sess_'

export function requireSession(): MiddlewareHandler<HonoApp> {
  return createSessionMiddleware({
    bearerPrefix: ADMIN_SESSION_BEARER_PREFIX,
    cookieNameEnvKey: 'ADMIN_SESSION_COOKIE_NAME',
    decryptBearer,
    errors: {
      unauthorized: () => errors.unauthorized(),
      upstreamUnavailable: () => errors.upstreamUnavailable(),
    },
  }) as MiddlewareHandler<HonoApp>
}
