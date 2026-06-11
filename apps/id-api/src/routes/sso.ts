import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { HonoApp } from '../context.js'
import type { UserId } from '@rallypoint/shared'
import { TENANT_DEFAULT, TOKEN_PREFIXES } from '@rallypoint/shared'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { requireAppApiKey } from '../middleware/app-api-key.js'
import { generateRawToken, hashToken, tokenHasPrefix } from '@rallypoint/crypto'
import { dailySalt, hashIp, hashUserAgent } from '../crypto/ip-hash.js'
import { issueSession } from '../session/issue.js'
import { extractIpFromContext } from '../http/extract-ip.js'
import { avatarPictureUrl } from '../avatar-url.js'

// Cross-app SSO bootstrap per docs/design/events-v1.md §3.13.
//
//   POST /api/v1/ui/sso/code     — cookie + CSRF. Signed-in RPID
//                                   user mints a single-use code
//                                   bound to (client, return_to_host).
//   POST /api/v1/sdk/sso/exchange — EVENTS_API_KEY bearer. Consumes
//                                   the code; mints a session for
//                                   the user; returns userinfo +
//                                   raw session bearer.
//
// Codes are 60-second TTL, single-use, hashed at rest.
// Closes Rallypoint Events #57 / #87 on the RPID side.

const SSO_CODE_TTL_MS = 60 * 1000

const CLIENT_ALLOWLIST = ['events', 'lists', 'money', 'planner'] as const

const MintBodySchema = z.object({
  client: z.string().min(1).max(64),
  return_to_host: z.string().min(1).max(253),
})

const ExchangeBodySchema = z.object({
  code: z.string().min(1),
})

// Per-client host allowlist. Returns the configured host for the
// given client (read from env at request time so tests with a
// fresh env shape work without re-importing). null = not configured.
function clientHost(client: string, env: HonoApp['Variables']['env']): string | null {
  if (client === 'events') return env.SSO_EVENTS_HOST ?? null
  if (client === 'lists') return env.SSO_LISTS_HOST ?? null
  if (client === 'money') return env.SSO_MONEY_HOST ?? null
  if (client === 'planner') return env.SSO_PLANNER_HOST ?? null
  return null
}

export const ssoRoutes = new Hono<HonoApp>()
  .post('/api/v1/ui/sso/code', requireSession('cookie'), async (c) => {
    const body = await readJsonBody(c)
    const parsed = MintBodySchema.safeParse(body)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { client, return_to_host: returnToHost } = parsed.data

    if (!CLIENT_ALLOWLIST.includes(client as (typeof CLIENT_ALLOWLIST)[number])) {
      throw new ApiError({
        code: 'sso_client_unknown',
        message: 'Unknown SSO client.',
        status: 400,
      })
    }
    const expectedHost = clientHost(client, c.var.env)
    if (!expectedHost) {
      // Client is allowlisted in code but no env-side host is
      // configured for it. Deploy bug, surfaced clearly.
      throw new ApiError({
        code: 'sso_client_unknown',
        message: 'SSO client is not configured on this deployment.',
        status: 400,
      })
    }
    if (returnToHost !== expectedHost) {
      throw new ApiError({
        code: 'sso_return_to_host_invalid',
        message: 'return_to_host does not match the configured host for this client.',
        status: 400,
      })
    }

    const session = c.var.session!
    const rawCode = generateRawToken(TOKEN_PREFIXES.sso)
    const codeHash = hashToken(rawCode)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SSO_CODE_TTL_MS)
    await c.var.repos.ssoCodes.create({
      codeHash,
      userId: session.userId,
      tenantId: session.tenantId,
      // Record the browser session minting this code so the consumer
      // session issued at exchange becomes a child of it (#93 SLO).
      mintingSessionIdHash: session.idHash,
      client,
      returnToHost,
      expiresAt,
    })
    auditSso(c, 'sso.code_minted', session.userId, { client, return_to_host: returnToHost })
    return c.json({ code: rawCode })
  })

  .post('/api/v1/sdk/sso/exchange', requireAppApiKey, async (c) => {
    const body = await readJsonBody(c)
    const parsed = ExchangeBodySchema.safeParse(body)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { code } = parsed.data

    const codeInvalid = (): never => {
      throw new ApiError({
        code: 'sso_code_invalid',
        message: 'Code is invalid or expired.',
        status: 400,
      })
    }

    if (!tokenHasPrefix(code, TOKEN_PREFIXES.sso)) return codeInvalid()

    const codeHash = hashToken(code)
    const row = await c.var.repos.ssoCodes.findByCodeHash(codeHash)
    if (!row) return codeInvalid()

    // Per-app key compartmentalisation (issue #159). requireAppApiKey
    // bound the matched key to c.var.appApiKeyClient; if the code was
    // minted for a DIFFERENT client, return the same opaque 400 as a
    // bad code so a leaked key can't fingerprint other apps' codes.
    if (
      c.var.appApiKeyClient !== undefined &&
      row.client !== c.var.appApiKeyClient
    ) {
      return codeInvalid()
    }

    if (row.consumedAt) {
      throw new ApiError({
        code: 'sso_code_already_consumed',
        message: 'Code has already been consumed.',
        status: 409,
      })
    }
    const now = new Date()
    if (row.expiresAt.getTime() < now.getTime()) return codeInvalid()

    // Atomic single-use guard: markConsumed only flips consumed_at
    // from NULL → `now`. Concurrent exchange callers race at the
    // DB; PG serialises the UPDATE and the loser gets `false`,
    // which MUST become 409 here. Without this, two concurrent
    // requests that both pass the row.consumedAt pre-check above
    // would both succeed and issue two sessions.
    const flipped = await c.var.repos.ssoCodes.markConsumed(codeHash, now)
    if (!flipped) {
      throw new ApiError({
        code: 'sso_code_already_consumed',
        message: 'Code has already been consumed.',
        status: 409,
      })
    }

    const user = await c.var.repos.users.findById(row.userId)
    if (!user) return codeInvalid() // FK cascade should make this unreachable.

    // Mint a fresh RPID session for the user. events-api stores
    // the raw bearer encrypted-at-rest (per §3.13 events side)
    // and calls verifySession() on each request.
    const salt = dailySalt(c.var.env.ARGON2_PEPPER)
    const ip = extractIpFromContext(c)
    const ua = c.req.header('user-agent') ?? '<events-api>'
    const issued = await issueSession(c.var.repos.sessions, {
      userId: user.id,
      tenantId: TENANT_DEFAULT,
      ipHash: hashIp(ip, salt),
      uaHash: hashUserAgent(ua),
      // Link the consumer session to the browser session that minted
      // the code so signout of either cascades the whole family (#93).
      parentSessionIdHash: row.mintingSessionIdHash,
    })

    auditSso(c, 'sso.code_exchanged', user.id, { client: row.client })

    return c.json({
      user_id: user.id,
      email: user.email,
      email_verified: user.emailVerified,
      // display_name and username are both the (non-unique) display
      // name now; kept as separate keys so SSO consumers don't break.
      display_name: user.username,
      first_name: user.firstName,
      last_name: user.lastName,
      picture_url: avatarPictureUrl(user, c.var.env.PUBLIC_BASE_URL),
      username: user.username,
      session_bearer: issued.rawToken,
      session_absolute_expires_at: issued.absoluteExpiresAt.toISOString(),
    })
  })

// Fire-and-log audit write (#23/#24). Best-effort: the row miss
// shouldn't fail the user-facing request.
function auditSso(
  c: Context<HonoApp>,
  eventType: string,
  userId: UserId | null,
  meta: Record<string, unknown>,
): void {
  const salt = dailySalt(c.var.env.ARGON2_PEPPER)
  const ip = extractIpFromContext(c)
  const ua = c.req.header('user-agent') ?? ''
  c.var.repos.audit
    .write({
      tenantId: TENANT_DEFAULT,
      eventType,
      userId,
      ipHash: hashIp(ip, salt),
      uaHash: hashUserAgent(ua),
      meta,
    })
    .catch((err: unknown) => {
      c.var.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        `${eventType} audit write failed`,
      )
    })
}

async function readJsonBody(c: { req: { raw: Request } }): Promise<unknown> {
  try {
    return await c.req.raw.json()
  } catch {
    throw errors.bodyInvalid()
  }
}
