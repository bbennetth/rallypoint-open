import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { HonoApp } from '../context.js'
import type { UserId } from '@rallypoint/shared'
import { TENANT_DEFAULT, TOKEN_PREFIXES } from '@rallypoint/shared'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { dailySalt, hashIp, hashUserAgent } from '../crypto/ip-hash.js'
import { extractIpFromContext } from '../http/extract-ip.js'

// Cross-app SSO bootstrap per docs/design/events-v1.md §3.13.
//
//   POST /api/v1/ui/sso/code     — cookie + CSRF. Signed-in RPID
//                                   user mints a single-use code
//                                   bound to (client, return_to_host).
//
// The companion `/api/v1/sdk/sso/exchange` HTTP endpoint was retired
// in PR 3 of feat/rpc-bindings: consumers (events-api, lists-api,
// money-api, planner-api) now call `IdRPC.exchangeSsoCode(code,
// { client })` through their `Service<IdRPC>` binding, so the
// per-app-key HTTP path is gone.
//
// Codes are 60-second TTL, single-use, hashed at rest.
// Closes Rallypoint Events #57 / #87 on the RPID side.

const SSO_CODE_TTL_MS = 60 * 1000

const CLIENT_ALLOWLIST = ['events', 'lists', 'money', 'planner', 'fitness', 'admin'] as const

const MintBodySchema = z.object({
  client: z.string().min(1).max(64),
  return_to_host: z.string().min(1).max(253),
})

// Per-client host allowlist. Returns the configured host for the
// given client (read from env at request time so tests with a
// fresh env shape work without re-importing). null = not configured.
function clientHost(client: string, env: HonoApp['Variables']['env']): string | null {
  if (client === 'events') return env.SSO_EVENTS_HOST ?? null
  if (client === 'lists') return env.SSO_LISTS_HOST ?? null
  if (client === 'money') return env.SSO_MONEY_HOST ?? null
  if (client === 'planner') return env.SSO_PLANNER_HOST ?? null
  if (client === 'fitness') return env.SSO_FITNESS_HOST ?? null
  if (client === 'admin') return env.SSO_ADMIN_HOST ?? null
  return null
}

export const ssoRoutes = new Hono<HonoApp>().post(
  '/api/v1/ui/sso/code',
  requireSession('cookie'),
  async (c) => {
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
  },
)

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
