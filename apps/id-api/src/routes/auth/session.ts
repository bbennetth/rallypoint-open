import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { HonoApp } from '../../context.js'
import type { UserId, UserInfo } from '@rallypoint/shared'
import { SHARED_SETTINGS_NAMESPACE, TOKEN_PREFIXES } from '@rallypoint/shared'
import { requireSession } from '../../middleware/session.js'
import { requireAppApiKey } from '../../middleware/app-api-key.js'
import { applyPerUserRateLimit } from '../../middleware/rate-limit.js'
import { errors } from '../../errors.js'
import { dailySalt, hashIp, hashUserAgent } from '../../crypto/ip-hash.js'
import { hashToken, readCookie, buildClearCookie } from '@rallypoint/crypto'
import type { SessionRecord } from '../../repos/session.js'
import { extractIpFromContext } from '../../http/extract-ip.js'
import { avatarPictureUrl } from '../../avatar-url.js'
import { buildSsoHintClearCookie } from '../../lib/sso-hint-cookie.js'

// Session-bearing routes per docs/design/api-namespaces-cors.md:
//
//   GET  /api/v1/ui/session    — cookie-authenticated userinfo
//   POST /api/v1/ui/signout    — cookie + delete row + clear cookie
//   POST /api/v1/sdk/session/verify  — bearer in body, returns userinfo
//   POST /api/v1/sdk/signout   — bearer in Authorization, delete row

const ReauthBodySchema = z.object({
  user_id: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
})

export const sessionRoutes = new Hono<HonoApp>()
  // ---- UI namespace --------------------------------------------------
  .get('/api/v1/ui/session', requireSession('cookie'), async (c) => {
    const user = await c.var.repos.users.findById(c.var.session!.userId)
    if (!user) throw errors.sessionRequired()
    // Fold the shared settings doc into the session probe so id-web
    // hydrates theme (and any other cross-app pref) in one round-trip.
    const settings =
      (await c.var.repos.settings.get(user.id as UserId, SHARED_SETTINGS_NAMESPACE)) ?? {}
    return c.json({ ...toUserInfo(user, c.var.env.PUBLIC_BASE_URL), settings })
  })
  .post('/api/v1/ui/signout', async (c) => {
    // Idempotent — always 200, never enumerate.
    const cookieName = c.var.env.SESSION_COOKIE_NAME
    const cookieHeader = c.req.header('cookie') ?? ''
    const cookieValue = readCookie(cookieHeader, cookieName)
    if (cookieValue && cookieValue.startsWith(TOKEN_PREFIXES.session)) {
      await signoutByToken(c, cookieValue, 'cookie')
    }
    const secure = c.var.env.NODE_ENV === 'production'
    c.header('Set-Cookie', buildClearCookie(cookieName, /* httpOnly */ true, secure))
    // Clear the SSO hint so JS on app subdomains stops attempting silent SSO.
    c.header(
      'Set-Cookie',
      buildSsoHintClearCookie({
        ...(c.var.env.SSO_HINT_COOKIE_DOMAIN ? { domain: c.var.env.SSO_HINT_COOKIE_DOMAIN } : {}),
        secure,
      }),
      { append: true },
    )
    return c.json({ ok: true })
  })

  // ---- SDK namespace -------------------------------------------------
  .post('/api/v1/sdk/session/verify', async (c) => {
    const body = await readBody(c)
    const token = (body as { token?: unknown }).token
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIXES.session)) {
      throw errors.bearerInvalid()
    }
    const idHash = hashToken(token)
    const cache = c.var.sessionCache
    let row =
      cache?.get(idHash) ?? (await c.var.repos.sessions.findByIdHash(idHash))
    if (row && row.absoluteExpiresAt.getTime() < Date.now()) row = null
    cache?.put(idHash, row ?? null)
    if (!row) throw errors.bearerInvalid()
    const user = await c.var.repos.users.findById(row.userId)
    if (!user) throw errors.bearerInvalid()
    return c.json(toUserInfo(user, c.var.env.PUBLIC_BASE_URL))
  })
  // Step-up re-authentication for downstream apps (events-api gates
  // transfer-ownership on it, design §3.5). EVENTS_API_KEY-gated; the
  // caller passes the user id + the password the user just typed. We
  // verify it against the stored password hash and return ok/fail —
  // no session is minted or touched. Per-user rate-limited so the
  // endpoint can't be turned into a password-guessing oracle.
  .post('/api/v1/sdk/session/reauth', requireAppApiKey, async (c) => {
    const parsed = ReauthBodySchema.safeParse(await readBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { user_id: userId, password } = parsed.data

    await applyPerUserRateLimit(c, {
      userId,
      route: 'session-reauth',
      limit: 10,
      windowSeconds: 10 * 60,
    })

    const auth = await c.var.repos.authMethods.findByUserAndKind(userId as UserId, 'password')
    if (!auth) {
      // Flatten timing against the verify path so a missing
      // password method is indistinguishable from a wrong password.
      await c.var.passwordHasher.dummyVerify()
      auditReauth(c, userId as UserId, false)
      return c.json({ ok: false, reason: 'reauth_failed' }, 401)
    }
    const ok = await c.var.passwordHasher.verify(auth.secretHash, auth.keyVersion, password)
    auditReauth(c, userId as UserId, ok)
    if (!ok) return c.json({ ok: false, reason: 'reauth_failed' }, 401)
    return c.json({ ok: true })
  })
  .post('/api/v1/sdk/signout', async (c) => {
    const auth = c.req.header('authorization') ?? ''
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice('Bearer '.length).trim()
      if (token.startsWith(TOKEN_PREFIXES.session)) {
        await signoutByToken(c, token, 'bearer')
      }
    }
    return c.json({ ok: true })
  })

// Shared token-based signout sequence (#52, #93). Both the UI
// (cookie) and SDK (bearer) paths hash the token, look up the row
// BEFORE deletion so the audit row carries the real userId/tenantId
// (#23), then cascade-delete the whole session family and invalidate
// the in-process cache for every deleted member.
//
// Single-logout (#93): an SSO-minted consumer session points at the
// browser login that minted its code (parentSessionId). The family
// root is `row.parentSessionId ?? row.idHash` — signing out of any
// member tears down the browser login AND every sibling consumer
// session, so "Sign out" actually signs you out everywhere in this
// browser. If the row is gone already (idempotent re-signout), fall
// back to deleting just this idHash.
async function signoutByToken(
  c: Context<HonoApp>,
  token: string,
  source: 'cookie' | 'bearer',
): Promise<void> {
  const idHash = hashToken(token)
  const row = await c.var.repos.sessions.findByIdHash(idHash)
  if (row) {
    const rootIdHash = row.parentSessionId ?? row.idHash
    const deleted = await c.var.repos.sessions.deleteSessionFamilyByRoot(rootIdHash)
    for (const deletedIdHash of deleted) {
      c.var.sessionCache?.invalidate(deletedIdHash)
    }
  } else {
    // Idempotent re-signout: the row is already gone (DB delete would
    // be a no-op), so there's no family to compute. Still evict any
    // stray cache entry defensively before auditing.
    c.var.sessionCache?.invalidate(idHash)
  }
  auditSignout(c, row, source)
}

export function toUserInfo(
  u: {
    id: string
    email: string
    emailVerified: boolean
    username: string
    firstName: string | null
    lastName: string | null
    pictureUrl: string | null
    avatarKey: string | null
    updatedAt: Date
  },
  publicBaseUrl: string,
): UserInfo {
  return {
    sub: u.id as `user_${string}`,
    email: u.email,
    email_verified: u.emailVerified,
    preferred_username: u.username,
    name: u.username,
    first_name: u.firstName,
    last_name: u.lastName,
    picture: avatarPictureUrl(u, publicBaseUrl),
    updated_at: u.updatedAt.toISOString(),
  }
}

// Fire-and-log audit write for step-up re-auth attempts (#23/#24).
function auditReauth(c: Context<HonoApp>, userId: UserId, ok: boolean): void {
  const salt = dailySalt(c.var.env.ARGON2_PEPPER)
  const ip = extractIpFromContext(c)
  const ua = c.req.header('user-agent') ?? ''
  c.var.repos.audit
    .write({
      tenantId: 'rallypoint',
      eventType: ok ? 'session.reauth_succeeded' : 'session.reauth_failed',
      userId,
      ipHash: hashIp(ip, salt),
      uaHash: hashUserAgent(ua),
      meta: { source: 'events-api' },
    })
    .catch((err: unknown) => {
      c.var.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'reauth audit write failed',
      )
    })
}

async function readBody(c: { req: { raw: Request } }): Promise<unknown> {
  try {
    return await c.req.raw.json()
  } catch {
    throw errors.bodyInvalid()
  }
}

// Fire-and-log audit write (#23 + #24). The session row carries
// the real userId + tenantId; pass it through so the audit row
// supports /admin/audit?userId=... queries. The write is
// fire-and-forget but its rejection is caught + logged at warn
// level rather than letting Node's unhandled-rejection-throw
// crash the worker.
function auditSignout(
  c: Context<HonoApp>,
  session: SessionRecord | null,
  source: 'cookie' | 'bearer',
): void {
  const salt = dailySalt(c.var.env.ARGON2_PEPPER)
  const ip = extractIpFromContext(c)
  const ua = c.req.header('user-agent') ?? ''
  c.var.repos.audit
    .write({
      tenantId: session?.tenantId ?? 'rallypoint',
      eventType: 'signout.success',
      userId: session?.userId ?? null,
      ipHash: hashIp(ip, salt),
      uaHash: hashUserAgent(ua),
      meta: { source, had_session_row: session !== null },
    })
    .catch((err: unknown) => {
      c.var.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'signout audit write failed',
      )
    })
}
