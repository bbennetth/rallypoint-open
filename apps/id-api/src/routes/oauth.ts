import { Hono } from 'hono'
import type { Context } from 'hono'
import { readCookie } from '@rallypoint/crypto'
import type { HonoApp } from '../context.js'
import type { Env } from '../env.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { resolveOptionalCookieSession } from '../middleware/session.js'
import { extractIpFromContext as extractIp } from '../http/extract-ip.js'
import { SESSION_LIFETIME_MS } from '../session/issue.js'
import { buildSsoHintCookie } from '../lib/sso-hint-cookie.js'
import { runOAuthStart, runOAuthCallback, type OAuthCoreDeps } from './oauth-core.js'

// Browser-redirect OAuth endpoints under /api/v1/oauth/* — sits OUTSIDE
// the /api/v1/ui/* CSRF + Origin middleware (see build-app.ts): a
// top-level provider redirect can't carry a CSRF header, so the `state`
// param + a per-transaction HttpOnly browser-bind cookie are the CSRF
// defense instead.

const BIND_COOKIE = 'rp_oauth_bind'
const BIND_TTL_S = 600

function collectSsoHosts(env: Env): string[] {
  return [
    env.SSO_EVENTS_HOST,
    env.SSO_LISTS_HOST,
    env.SSO_MONEY_HOST,
    env.SSO_PLANNER_HOST,
    env.SSO_FITNESS_HOST,
    env.SSO_ADMIN_HOST,
  ].filter((h): h is string => typeof h === 'string' && h.length > 0)
}

function coreDeps(c: Context<HonoApp>): OAuthCoreDeps {
  return {
    repos: c.var.repos,
    providers: c.var.oauthProviders,
    sessionHmacKey: c.var.env.SESSION_HMAC_KEY,
    argon2PepperKey: c.var.env.ARGON2_PEPPER,
    uiOrigin: c.var.env.UI_ORIGIN,
    redirectBaseUrl: c.var.env.OAUTH_REDIRECT_BASE_URL ?? c.var.env.PUBLIC_BASE_URL,
    allowedReturnHosts: collectSsoHosts(c.var.env),
    logger: c.var.logger,
  }
}

// SameSite=None (needs Secure) so the cookie survives Apple's cross-site
// form_post callback; falls back to Lax over http in dev (Google/GitHub
// use a same-site top-level GET callback where Lax is enough).
function bindCookie(value: string, maxAge: number, secure: boolean): string {
  const sameSite = secure ? 'None' : 'Lax'
  return `${BIND_COOKIE}=${value}; Path=/api/v1/oauth; Max-Age=${maxAge}; ${secure ? 'Secure; ' : ''}HttpOnly; SameSite=${sameSite}`
}

function appendSessionCookies(c: Context<HonoApp>, token: string): void {
  const maxAge = Math.floor(SESSION_LIFETIME_MS / 1000)
  const secure = c.var.env.NODE_ENV === 'production'
  c.header(
    'Set-Cookie',
    `${c.var.env.SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; ${secure ? 'Secure; ' : ''}HttpOnly; SameSite=Lax`,
    { append: true },
  )
  c.header(
    'Set-Cookie',
    buildSsoHintCookie({
      maxAgeSeconds: maxAge,
      ...(c.var.env.SSO_HINT_COOKIE_DOMAIN ? { domain: c.var.env.SSO_HINT_COOKIE_DOMAIN } : {}),
      secure,
    }),
    { append: true },
  )
}

async function handleCallback(c: Context<HonoApp>): Promise<Response> {
  let code: string | null
  let state: string | null
  let error: string | null
  let appleUser: string | null
  if (c.req.method === 'POST') {
    const form = await c.req.parseBody()
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
    code = str(form['code'])
    state = str(form['state'])
    error = str(form['error'])
    appleUser = str(form['user'])
  } else {
    code = c.req.query('code') ?? null
    state = c.req.query('state') ?? null
    error = c.req.query('error') ?? null
    appleUser = null
  }

  const outcome = await runOAuthCallback(coreDeps(c), {
    provider: c.req.param('provider') ?? '',
    code,
    state,
    error,
    appleUser,
    bindCookie: readCookie(c.req.header('cookie') ?? '', BIND_COOKIE),
    ipAddress: extractIp(c),
    userAgent: c.req.header('user-agent') ?? '',
  })

  const secure = c.var.env.NODE_ENV === 'production'
  c.header('Set-Cookie', bindCookie('', 0, secure)) // clear the bind cookie
  if (outcome.kind === 'success') appendSessionCookies(c, outcome.sessionToken)
  return c.redirect(outcome.location, 302)
}

export const oauthRoutes = new Hono<HonoApp>()
  .use(
    '/api/v1/oauth/:provider/start',
    rateLimit({ route: 'oauth-start', perIp: { limit: 20, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/oauth/:provider/callback',
    rateLimit({ route: 'oauth-callback', perIp: { limit: 20, windowSeconds: 10 * 60 } }),
  )
  .get('/api/v1/oauth/:provider/start', async (c) => {
    const session = await resolveOptionalCookieSession(c)
    const outcome = await runOAuthStart(coreDeps(c), {
      provider: c.req.param('provider'),
      returnTo: c.req.query('returnTo') ?? null,
      link: c.req.query('link') === '1',
      sessionUserId: session?.userId ?? null,
    })
    const secure = c.var.env.NODE_ENV === 'production'
    c.header('Set-Cookie', bindCookie(outcome.bindCookieValue, BIND_TTL_S, secure))
    return c.redirect(outcome.authorizeUrl, 302)
  })
  .get('/api/v1/oauth/:provider/callback', handleCallback)
  .post('/api/v1/oauth/:provider/callback', handleCallback)
