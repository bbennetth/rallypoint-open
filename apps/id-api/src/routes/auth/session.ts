import { Hono } from 'hono'
import type { HonoApp } from '../../context.js'
import type { UserId } from '@rallypoint/shared'
import { SHARED_SETTINGS_NAMESPACE, TOKEN_PREFIXES } from '@rallypoint/shared'
import { requireSession } from '../../middleware/session.js'
import { errors } from '../../errors.js'
import { readCookie, buildClearCookie } from '@rallypoint/crypto'
import { buildSsoHintClearCookie } from '../../lib/sso-hint-cookie.js'
import { signoutSessionCore, toUserInfo } from '../../services/rpc-core/index.js'

// UI session routes (id-web cookie surface). The cross-Worker SDK
// endpoints — `/sdk/session/verify`, `/sdk/session/reauth`, and
// `/sdk/signout` — were retired in PR 3 of feat/rpc-bindings: every
// consumer (events/lists/money/planner/lists-mcp) now reaches id-api
// through the `IdRPC` `WorkerEntrypoint` binding, so the HTTP path
// + the `EVENTS_API_KEY` / `LISTS_API_KEY` / `MONEY_API_KEY` /
// `PLANNER_API_KEY` bearer gate are no longer needed.

export const sessionRoutes = new Hono<HonoApp>()
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
      await signoutSessionCore(
        cookieValue,
        'cookie',
        {
          env: c.var.env,
          logger: c.var.logger,
          repos: c.var.repos,
          services: c.var.services,
          passwordHasher: c.var.passwordHasher,
          ...(c.var.sessionCache ? { sessionCache: c.var.sessionCache } : {}),
        },
        { ip: null, userAgent: c.req.header('user-agent') ?? null },
      )
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

// `toUserInfo` moved to services/rpc-core/user-info.ts so the IdRPC
// class can import it without dragging in route deps; re-export here to
// keep external callers (avatar.ts, …) working unchanged.
export { toUserInfo } from '../../services/rpc-core/user-info.js'
