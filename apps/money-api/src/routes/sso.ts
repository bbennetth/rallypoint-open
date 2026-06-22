import { Hono } from 'hono'
import { z } from 'zod'
import { SHARED_SETTINGS_NAMESPACE, type SessionProfile } from '@rallypoint/shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { generateRawToken, hashToken, constantTimeEqual, readCookie, buildSetCookie, buildClearCookie, extractIp, dailySalt, hashIp, hashUserAgent } from '@rallypoint/crypto'
import { encryptBearer, decryptBearer } from '../crypto/encryption.js'
import { MONEY_SESSION_BEARER_PREFIX, requireSession } from '../middleware/session.js'
import { csrfIssueHandler } from '../middleware/csrf.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { readJsonBody } from './_body.js'

// SSO + session-lifecycle routes (money side of the §3.13 bootstrap,
// mirroring apps/lists-api). All live under /api/v1/ui/* so origin +
// CSRF middleware front them; none require an existing session.

const ExchangeBodySchema = z.object({
  code: z.string().min(1).max(256),
  state: z.string().min(1).max(256),
})

// 10 exchange attempts per IP per 10 minutes — brute-force protection.
// Applied before the state-cookie check and RPID exchange so it fires
// on every request regardless of whether the caller has a valid state cookie.
const exchangeRateLimit = rateLimit({
  route: 'sso-exchange',
  perIp: { limit: 10, windowSeconds: 600 },
})

export const ssoRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/csrf', csrfIssueHandler)

  .post('/api/v1/ui/sso/exchange', exchangeRateLimit, async (c) => {
    const env = c.var.env
    const body = await readJsonBody(c)
    const parsed = ExchangeBodySchema.safeParse(body)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { code, state } = parsed.data

    const stateCookieName = env.MONEY_SSO_STATE_COOKIE_NAME
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

    // Mint the money bearer, seal the RPID bearer AAD-bound to the new
    // row's id_hash, and persist the session.
    const moneyBearer = generateRawToken(MONEY_SESSION_BEARER_PREFIX)
    const idHash = hashToken(moneyBearer)
    const sealed = encryptBearer({
      plaintext: result.sessionBearer,
      aad: idHash,
      env: { MONEY_SESSION_KEY_V1: env.MONEY_SESSION_KEY_V1 },
      keyVersion: env.MONEY_SESSION_KEY_VERSION,
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
        dailySalt(env.MONEY_SESSION_KEY_V1),
      ),
      // ua_hash remains an unsalted sha256: UA strings are not
      // pseudonymous identifiers and rotating them would lose
      // device-switch correlation in the audit log.
      uaHash: hashUserAgent(c.req.header('user-agent') ?? ''),
    })

    const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - Date.now()) / 1000))
    c.header(
      'Set-Cookie',
      buildSetCookie(env.MONEY_SESSION_COOKIE_NAME, moneyBearer, {
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
    // Fold the shared cross-app settings doc (theme etc.) and the RPID
    // profile (avatar + name) into the probe so the web app hydrates in one
    // round-trip. They are independent RPID reads, so run them concurrently.
    // Both are best-effort: a settings hiccup degrades to an empty doc and a
    // profile hiccup to `null` (the bar falls back to initials) — neither
    // must break an otherwise-valid session.
    const [settingsResult, profileResult] = await Promise.allSettled([
      c.var.services.settings.get(userId, SHARED_SETTINGS_NAMESPACE),
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
    return c.json({ user_id: userId, settings, profile })
  })

  .post('/api/v1/ui/signout', async (c) => {
    const env = c.var.env
    const raw = readCookie(c.req.header('cookie') ?? '', env.MONEY_SESSION_COOKIE_NAME)
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
            env: { MONEY_SESSION_KEY_V1: env.MONEY_SESSION_KEY_V1 },
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
    c.header('Set-Cookie', buildClearCookie(env.MONEY_SESSION_COOKIE_NAME, true, env.NODE_ENV === 'production'))
    return c.body(null, 204)
  })
