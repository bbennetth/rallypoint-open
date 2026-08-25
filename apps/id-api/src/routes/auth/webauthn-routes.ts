import { Hono } from 'hono'
import type { Context } from 'hono'
import type { HonoApp } from '../../context.js'
import { requireSession } from '../../middleware/session.js'
import { rateLimit, applyPerUserRateLimit } from '../../middleware/rate-limit.js'
import { SESSION_LIFETIME_MS } from '../../session/issue.js'
import { buildSsoHintCookie } from '../../lib/sso-hint-cookie.js'
import { extractIpFromContext as extractIp } from '../../http/extract-ip.js'
import { errors } from '../../errors.js'
import {
  handleRegisterStart,
  handleRegisterFinish,
  handleAuthenticateStart,
  handleAuthenticateFinish,
  handleListCredentials,
  handleRenameCredential,
  handleDeleteCredential,
  type WebAuthnCtx,
} from './webauthn.js'

// Passkey routes under /api/v1/ui/webauthn/* — same-origin fetch()
// calls, so the app-wide CSRF + Origin middleware already guards them.
// register/* + credentials/* require a session; authenticate/* do not
// (usernameless login) but a successful finish mints the session cookie.

function webauthnCtx(c: Context<HonoApp>): WebAuthnCtx {
  return {
    repos: c.var.repos,
    argon2PepperKey: c.var.env.ARGON2_PEPPER,
    sessionHmacKey: c.var.env.SESSION_HMAC_KEY,
    publicBaseUrl: c.var.env.PUBLIC_BASE_URL,
    rpId: c.var.env.WEBAUTHN_RP_ID,
    rpName: c.var.env.WEBAUTHN_RP_NAME,
    origins: c.var.env.WEBAUTHN_ORIGIN.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ipAddress: extractIp(c),
    userAgent: c.req.header('user-agent') ?? '',
    logger: c.var.logger,
  }
}

async function readJsonBody(c: Context<HonoApp>): Promise<unknown> {
  try {
    return await c.req.raw.json()
  } catch {
    throw errors.bodyInvalid()
  }
}

function setSessionCookies(c: Context<HonoApp>, sessionToken: string): void {
  const maxAge = Math.floor(SESSION_LIFETIME_MS / 1000)
  const secure = c.var.env.NODE_ENV === 'production'
  c.header(
    'Set-Cookie',
    `${c.var.env.SESSION_COOKIE_NAME}=${sessionToken}; Path=/; Max-Age=${maxAge}; ${secure ? 'Secure; ' : ''}HttpOnly; SameSite=Lax`,
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

export const webauthnRoutes = new Hono<HonoApp>()
  .use(
    '/api/v1/ui/webauthn/register/start',
    rateLimit({ route: 'webauthn-register-start', perIp: { limit: 20, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/webauthn/register/finish',
    rateLimit({ route: 'webauthn-register-finish', perIp: { limit: 20, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/webauthn/authenticate/start',
    rateLimit({ route: 'webauthn-auth-start', perIp: { limit: 30, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/webauthn/authenticate/finish',
    rateLimit({ route: 'webauthn-auth-finish', perIp: { limit: 30, windowSeconds: 10 * 60 } }),
  )
  .post('/api/v1/ui/webauthn/register/start', requireSession('cookie'), async (c) => {
    await applyPerUserRateLimit(c, {
      userId: c.var.session!.userId,
      route: 'webauthn-register',
      limit: 10,
      windowSeconds: 3600,
    })
    const options = await handleRegisterStart(webauthnCtx(c), c.var.session!.userId)
    return c.json(options)
  })
  .post('/api/v1/ui/webauthn/register/finish', requireSession('cookie'), async (c) => {
    await applyPerUserRateLimit(c, {
      userId: c.var.session!.userId,
      route: 'webauthn-register',
      limit: 10,
      windowSeconds: 3600,
    })
    const body = await readJsonBody(c)
    const result = await handleRegisterFinish(body, webauthnCtx(c), c.var.session!.userId)
    return c.json(result)
  })
  .post('/api/v1/ui/webauthn/authenticate/start', async (c) => {
    const options = await handleAuthenticateStart(webauthnCtx(c))
    return c.json(options)
  })
  .post('/api/v1/ui/webauthn/authenticate/finish', async (c) => {
    const body = await readJsonBody(c)
    const result = await handleAuthenticateFinish(body, webauthnCtx(c))
    setSessionCookies(c, result.sessionToken)
    // Cookie is the auth surface for UI callers — strip the raw token.
    const { sessionToken: _t, ...uiPayload } = result
    return c.json(uiPayload)
  })
  .get('/api/v1/ui/webauthn/credentials', requireSession('cookie'), async (c) => {
    return c.json(await handleListCredentials(webauthnCtx(c), c.var.session!.userId))
  })
  .patch('/api/v1/ui/webauthn/credentials/:id', requireSession('cookie'), async (c) => {
    const body = await readJsonBody(c)
    const result = await handleRenameCredential(
      body,
      webauthnCtx(c),
      c.var.session!.userId,
      c.req.param('id'),
    )
    return c.json(result)
  })
  .delete('/api/v1/ui/webauthn/credentials/:id', requireSession('cookie'), async (c) => {
    const result = await handleDeleteCredential(
      webauthnCtx(c),
      c.var.session!.userId,
      c.req.param('id'),
    )
    return c.json(result)
  })
