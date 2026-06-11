import type { Context, MiddlewareHandler } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { hashToken, tokenHasPrefix, readCookie, buildClearCookie } from '@rallypoint/crypto'
import { decryptBearer } from '../crypto/encryption.js'

// lists-side session resolution (events-v1 design §3.13, reused). The
// cookie carries the opaque lists bearer; we store sha256(bearer) as
// the row PK and the RPID bearer AES-GCM-sealed alongside. On every
// request we:
//
//   1. look the row up by id_hash,
//   2. decrypt the stored RPID bearer,
//   3. re-verify it against RPID via the id-client (30s-cached).
//
// Revocation cascade — the security-critical part:
//   - unknown / expired row, or RPID says the bearer is invalid →
//     DELETE the row + clear the cookie + 401. A revoked RPID session
//     must not leave a live lists session behind.
//   - RPID unreachable (transport error) → 503, and DO NOT delete the
//     row. A transient RPID hiccup is not a revocation; nuking sessions
//     on a blip would sign everyone out on every outage.
//
// We return the 401 responses directly (rather than throwing) so the
// Set-Cookie that clears the cookie survives — the error handler builds
// a fresh Response and would drop headers set on a throw.

export const LISTS_SESSION_BEARER_PREFIX = 'rpl_sess_'

function clearedUnauthorized(
  c: Context<HonoApp>,
  cookieName: string,
  message: string,
): Response {
  c.header('Set-Cookie', buildClearCookie(cookieName, true, c.var.env.NODE_ENV === 'production'))
  return c.json({ error: { code: 'unauthorized', message } }, 401)
}

export function requireSession(): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    const cookieName = c.var.env.LISTS_SESSION_COOKIE_NAME
    const raw = readCookie(c.req.header('cookie') ?? '', cookieName)
    if (!raw) {
      throw errors.unauthorized()
    }
    if (!tokenHasPrefix(raw, LISTS_SESSION_BEARER_PREFIX)) {
      // Cookie present but wrong prefix — clear the stale cookie and 401.
      return clearedUnauthorized(c, cookieName, 'Session token invalid.')
    }

    const idHash = hashToken(raw)
    const row = await c.var.repos.sessions.findByIdHash(idHash)
    if (!row || row.absoluteExpiresAt.getTime() <= Date.now()) {
      if (row) await c.var.repos.sessions.deleteByIdHash(idHash)
      return clearedUnauthorized(c, cookieName, 'Session expired or unknown.')
    }

    let bearer: string
    try {
      bearer = decryptBearer({
        ciphertext: row.rpidBearerCiphertext,
        nonce: row.rpidBearerNonce,
        keyVersion: row.rpidBearerKeyVersion,
        aad: idHash,
        env: { LISTS_SESSION_KEY_V1: c.var.env.LISTS_SESSION_KEY_V1 },
      })
    } catch {
      // Sealed bearer no longer decrypts (key rotated away / tamper).
      // The row is unusable → revoke it.
      await c.var.repos.sessions.deleteByIdHash(idHash)
      return clearedUnauthorized(c, cookieName, 'Session key unavailable.')
    }

    let verify: Awaited<ReturnType<typeof c.var.services.idClient.verifyRpidBearer>>
    try {
      verify = await c.var.services.idClient.verifyRpidBearer(bearer)
    } catch {
      // RPID unreachable — preserve the row, surface 503.
      throw errors.upstreamUnavailable()
    }
    if (!verify.ok || verify.userId !== row.userId) {
      await c.var.repos.sessions.deleteByIdHash(idHash)
      return clearedUnauthorized(c, cookieName, 'Session revoked.')
    }

    await c.var.repos.sessions.touchLastSeen(idHash, new Date())
    c.set('session', { idHash, userId: row.userId })
    await next()
  }
}
