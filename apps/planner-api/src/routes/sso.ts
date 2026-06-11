import { Hono } from 'hono'
import { z } from 'zod'
import { SHARED_SETTINGS_NAMESPACE } from '@rallypoint/shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { generateRawToken, hashToken, constantTimeEqual, readCookie, buildSetCookie, buildClearCookie, extractIp, dailySalt, hashIp, hashUserAgent } from '@rallypoint/crypto'
import { encryptBearer, decryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX, requireSession } from '../middleware/session.js'
import { csrfIssueHandler } from '../middleware/csrf.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { readJsonBody } from './_body.js'

// SSO + session-lifecycle routes (planner side of the §3.13 bootstrap,
// mirroring apps/money-api). All live under /api/v1/ui/* so origin +
// CSRF middleware front them; none require an existing session.

const ExchangeBodySchema = z.object({
  code: z.string().min(1).max(256),
  state: z.string().min(1).max(256),
})

export const ssoRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/csrf', csrfIssueHandler)

  // Per-IP rate limit: 10 requests per 10 minutes. Applied BEFORE the
  // expensive RPID exchange call to prevent abuse of the SSO endpoint.
  .post(
    '/api/v1/ui/sso/exchange',
    rateLimit({ route: 'sso-exchange', perIp: { limit: 10, windowSeconds: 600 } }),
    async (c) => {
    const env = c.var.env
    const body = await readJsonBody(c)
    const parsed = ExchangeBodySchema.safeParse(body)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { code, state } = parsed.data

    const stateCookieName = env.PLANNER_SSO_STATE_COOKIE_NAME
    const cookieState = readCookie(c.req.header('cookie') ?? '', stateCookieName)
    c.header('Set-Cookie', buildClearCookie(stateCookieName, false, env.NODE_ENV === 'production'))
    if (!cookieState || !constantTimeEqual(cookieState, state)) {
      throw new ApiError({
        code: 'sso_state_mismatch',
        message: 'SSO state did not match.',
        status: 400,
      })
    }

    const exchanged = await c.var.services.rpidSso.exchange(code)
    if (!exchanged.ok) {
      if (exchanged.reason === 'already_consumed') {
        throw errors.conflict('sso_code_already_consumed', 'Code has already been consumed.')
      }
      throw new ApiError({
        code: 'sso_code_invalid',
        message: 'Code is invalid or expired.',
        status: 400,
      })
    }
    const result = exchanged.result

    // Mint the planner bearer, seal the RPID bearer AAD-bound to the new
    // row's id_hash, and persist the session.
    const plannerBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
    const idHash = hashToken(plannerBearer)
    const sealed = encryptBearer({
      plaintext: result.sessionBearer,
      aad: idHash,
      env: { PLANNER_SESSION_KEY_V1: env.PLANNER_SESSION_KEY_V1 },
      keyVersion: env.PLANNER_SESSION_KEY_VERSION,
    })
    const absoluteExpiresAt = new Date(result.sessionAbsoluteExpiresAt)

    await c.var.repos.sessions.create({
      idHash,
      userId: result.userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt,
      // ip_hash uses a daily-salted sha256 so stored hashes rotate and
      // cannot be pivoted against historical rows. Rows written before
      // this change hold an unsalted hash — audit-only field, never
      // compared, no migration needed.
      ipHash: hashIp(
        extractIp({ headers: c.req.raw.headers, policy: env.TRUSTED_PROXY_HEADER }),
        dailySalt(env.PLANNER_SESSION_KEY_V1),
      ),
      // ua_hash remains an unsalted sha256: UA strings are not
      // pseudonymous identifiers and rotating them would lose
      // device-switch correlation in the audit log.
      uaHash: hashUserAgent(c.req.header('user-agent') ?? ''),
    })

    const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - Date.now()) / 1000))
    c.header(
      'Set-Cookie',
      buildSetCookie(env.PLANNER_SESSION_COOKIE_NAME, plannerBearer, {
        maxAge,
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
      }),
      { append: true },
    )
    return c.body(null, 204)
  })

  .get('/api/v1/ui/session', requireSession(), async (c) => {
    const userId = c.var.session!.userId
    // Fold the shared cross-app settings doc (theme etc.) into the probe
    // so the web app hydrates in one round-trip. Best-effort: a settings
    // fetch failure (RPID hiccup) must not break an otherwise-valid
    // session, so degrade to an empty doc.
    let settings: Record<string, unknown> = {}
    try {
      settings = await c.var.services.settings.get(userId, SHARED_SETTINGS_NAMESPACE)
    } catch (err) {
      c.var.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'shared settings fold-in failed; returning empty doc',
      )
    }

    // Fold the RPID profile (avatar + name) into the probe too so the
    // user bar renders the real user in one round-trip. Best-effort: an
    // RPID batch-lookup hiccup must not break an otherwise-valid session,
    // so degrade to `null` (the bar falls back to initials).
    let profile: {
      username: string | null
      first_name: string | null
      last_name: string | null
      picture_url: string | null
      email: string | null
    } | null = null
    try {
      const entry = await c.var.services.profiles.lookup(userId)
      if (entry) {
        profile = {
          username: entry.display_name,
          first_name: entry.first_name,
          last_name: entry.last_name,
          picture_url: entry.picture_url,
          email: entry.email,
        }
      }
    } catch (err) {
      c.var.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'profile fold-in failed; returning null',
      )
    }
    return c.json({ user_id: userId, settings, profile })
  })

  .post('/api/v1/ui/signout', async (c) => {
    const env = c.var.env
    const raw = readCookie(c.req.header('cookie') ?? '', env.PLANNER_SESSION_COOKIE_NAME)
    if (raw) {
      const idHash = hashToken(raw)
      const row = await c.var.repos.sessions.findByIdHash(idHash)
      if (row) {
        // Single logout (#93): tear down the upstream RPID session so
        // signing out here also ends the RPID session and, by way of
        // each sibling app's per-request re-verify, their sessions too.
        // Best-effort — a missing/undecryptable bearer or an RPID
        // hiccup must never block the local signout.
        try {
          const bearer = decryptBearer({
            ciphertext: row.rpidBearerCiphertext,
            nonce: row.rpidBearerNonce,
            keyVersion: row.rpidBearerKeyVersion,
            aad: idHash,
            env: { PLANNER_SESSION_KEY_V1: env.PLANNER_SESSION_KEY_V1 },
          })
          await c.var.services.idClient.signoutRpidBearer(bearer)
        } catch (err) {
          c.var.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'rpid single-logout propagation failed',
          )
        }
        await c.var.repos.sessions.deleteByIdHash(idHash)
      }
    }
    c.header('Set-Cookie', buildClearCookie(env.PLANNER_SESSION_COOKIE_NAME, true, env.NODE_ENV === 'production'))
    return c.body(null, 204)
  })
