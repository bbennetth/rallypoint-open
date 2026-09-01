import { Hono } from 'hono'
import {
  createSsoExchangeHandler,
  createSessionProbeHandler,
  createSignoutHandler,
} from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { encryptBearer, decryptBearer } from '../crypto/encryption.js'
import { LISTS_SESSION_BEARER_PREFIX, requireSession } from '../middleware/session.js'
import { csrfIssueHandler } from '../middleware/csrf.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { readJsonBody } from './_body.js'

// SSO + session-lifecycle routes (lists side of the §3.13 bootstrap). The
// handler bodies (exchange / session-probe / signout) are the shared
// @rallypoint/api-kit factories (R2 dedup); this file owns only the route
// wiring + app-specific middleware (csrf, rate-limit) + naming.

export const ssoRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/csrf', csrfIssueHandler)
  .post(
    '/api/v1/ui/sso/exchange',
    rateLimit({ route: 'sso-exchange', onStoreError: 'deny', perIp: { limit: 10, windowSeconds: 10 * 60 } }),
    createSsoExchangeHandler({
      bearerPrefix: LISTS_SESSION_BEARER_PREFIX,
      stateCookieEnvKey: 'LISTS_SSO_STATE_COOKIE_NAME',
      sessionCookieEnvKey: 'LISTS_SESSION_COOKIE_NAME',
      keyV1EnvKey: 'LISTS_SESSION_KEY_V1',
      keyVersionEnvKey: 'LISTS_SESSION_KEY_VERSION',
      encryptBearer,
      readJsonBody,
      errors: {
        validation: (issues) => errors.validation({ issues }),
        stateMismatch: () =>
          new ApiError({ code: 'sso_state_mismatch', message: 'SSO state did not match.', status: 400 }),
        codeInvalid: () =>
          new ApiError({ code: 'sso_code_invalid', message: 'Code is invalid or expired.', status: 400 }),
        codeAlreadyConsumed: () =>
          errors.conflict('sso_code_already_consumed', 'Code has already been consumed.'),
      },
    }),
  )
  .get('/api/v1/ui/session', requireSession(), createSessionProbeHandler())
  .post(
    '/api/v1/ui/signout',
    createSignoutHandler({
      sessionCookieEnvKey: 'LISTS_SESSION_COOKIE_NAME',
      keyV1EnvKey: 'LISTS_SESSION_KEY_V1',
      decryptBearer,
    }),
  )
