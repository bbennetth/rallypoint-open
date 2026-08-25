import { Hono } from 'hono'
import { SHARED_SETTINGS_NAMESPACE, type SessionProfile } from '@rallypoint/shared'
import {
  createSsoExchangeHandler,
  createSignoutHandler,
} from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { encryptBearer, decryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX, requireSession } from '../middleware/session.js'
import { csrfIssueHandler } from '../middleware/csrf.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { readJsonBody } from './_body.js'

// SSO + session-lifecycle routes (fitness side of the §3.13 bootstrap). The
// exchange and signout handler bodies are the shared @rallypoint/api-kit
// factories (R2 dedup); this file owns the route wiring + app-specific
// middleware (csrf, rate-limit) + naming.
//
// NOTE: the session probe is kept inline because fitness folds a second
// app-scoped settings namespace (FITNESS_SETTINGS_NAMESPACE) into the
// response alongside the shared bag — a fitness-specific behaviour the
// generic createSessionProbeHandler() factory does not support.

// This app's own RPID settings namespace — the session probe folds its
// doc (weightUnit etc.) in alongside the shared bag. Mirrors the
// FITNESS_CLIENT constant the settings passthrough route validates against.
const FITNESS_SETTINGS_NAMESPACE = 'fitness'

export const ssoRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/csrf', csrfIssueHandler)
  .post(
    '/api/v1/ui/sso/exchange',
    rateLimit({ route: 'sso-exchange', perIp: { limit: 10, windowSeconds: 600 } }),
    createSsoExchangeHandler({
      bearerPrefix: FITNESS_SESSION_BEARER_PREFIX,
      stateCookieEnvKey: 'FITNESS_SSO_STATE_COOKIE_NAME',
      sessionCookieEnvKey: 'FITNESS_SESSION_COOKIE_NAME',
      keyV1EnvKey: 'FITNESS_SESSION_KEY_V1',
      keyVersionEnvKey: 'FITNESS_SESSION_KEY_VERSION',
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
  .get('/api/v1/ui/session', requireSession(), async (c) => {
    const userId = c.var.session!.userId
    // Fold the shared cross-app settings doc (theme etc.) and the RPID
    // profile (avatar + name) into the probe so the web app hydrates in one
    // round-trip. Both are best-effort: a settings hiccup degrades to an empty
    // doc and a profile hiccup to `null` — neither must break a valid session.
    const [settingsResult, appSettingsResult, profileResult] = await Promise.allSettled([
      c.var.services.settings.get(userId, SHARED_SETTINGS_NAMESPACE),
      c.var.services.settings.get(userId, FITNESS_SETTINGS_NAMESPACE),
      c.var.services.profiles.lookup(userId),
    ])

    let settings: Record<string, unknown> = {}
    if (settingsResult.status === 'fulfilled') {
      settings = settingsResult.value
    } else {
      const reason = settingsResult.reason
      c.var.logger.warn(
        { err: reason instanceof Error ? reason.message : String(reason) },
        'shared settings fold-in failed; returning empty doc',
      )
    }

    // The fitness-scoped bag (weightUnit etc.) folds in the same way, in the
    // same round-trip, degrading to an empty doc on a hiccup.
    let appSettings: Record<string, unknown> = {}
    if (appSettingsResult.status === 'fulfilled') {
      appSettings = appSettingsResult.value
    } else {
      const reason = appSettingsResult.reason
      c.var.logger.warn(
        { err: reason instanceof Error ? reason.message : String(reason) },
        'fitness settings fold-in failed; returning empty doc',
      )
    }

    let profile: SessionProfile | null = null
    if (profileResult.status === 'fulfilled') {
      const entry = profileResult.value
      if (entry) {
        profile = {
          username: entry.display_name,
          first_name: entry.first_name,
          last_name: entry.last_name,
          picture_url: entry.picture_url,
          email: entry.email,
        }
      }
    } else {
      const reason = profileResult.reason
      c.var.logger.warn(
        { err: reason instanceof Error ? reason.message : String(reason) },
        'profile fold-in failed; returning null',
      )
    }
    return c.json({ user_id: userId, settings, app_settings: appSettings, profile })
  })
  .post(
    '/api/v1/ui/signout',
    createSignoutHandler({
      sessionCookieEnvKey: 'FITNESS_SESSION_COOKIE_NAME',
      keyV1EnvKey: 'FITNESS_SESSION_KEY_V1',
      decryptBearer,
    }),
  )
