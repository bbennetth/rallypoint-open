import { Hono } from 'hono'
import {
  createSsoExchangeHandler,
  createSessionProbeHandler,
  createSignoutHandler,
} from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { encryptBearer, decryptBearer } from '../crypto/encryption.js'
import { ADMIN_SESSION_BEARER_PREFIX, requireSession } from '../middleware/session.js'
import { csrfIssueHandler } from '../middleware/csrf.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { readJsonBody } from './_body.js'

// SSO + session-lifecycle routes (admin side of the §3.13 bootstrap). The
// exchange / probe / signout handler bodies are the shared
// @rallypoint/api-kit factories (R2 dedup); this file owns the route wiring
// + app-specific middleware (csrf, rate-limit) + naming.
//
// NOTE: the session probe is deliberately NOT behind requireAdmin — a
// signed-in non-admin gets a valid probe (so the SPA can show a friendly
// "not an admin" state) but every /submissions route 403s.

export const ssoRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/csrf', csrfIssueHandler)
  .post(
    '/api/v1/ui/sso/exchange',
    rateLimit({ route: 'sso-exchange', perIp: { limit: 10, windowSeconds: 600 } }),
    createSsoExchangeHandler({
      bearerPrefix: ADMIN_SESSION_BEARER_PREFIX,
      stateCookieEnvKey: 'ADMIN_SSO_STATE_COOKIE_NAME',
      sessionCookieEnvKey: 'ADMIN_SESSION_COOKIE_NAME',
      keyV1EnvKey: 'ADMIN_SESSION_KEY_V1',
      keyVersionEnvKey: 'ADMIN_SESSION_KEY_VERSION',
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
      sessionCookieEnvKey: 'ADMIN_SESSION_COOKIE_NAME',
      keyV1EnvKey: 'ADMIN_SESSION_KEY_V1',
      decryptBearer,
    }),
  )
