import { randomBytes } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import type { HonoApp } from '../context.js'
import { constantTimeEqual, readCookie, buildSetCookie } from '@rallypoint/crypto'
import { errors } from '../errors.js'

// CSRF double-submit, ported from apps/lists-api. GET /api/v1/ui/csrf
// issues a random token in a JS-readable cookie + body; state-changing
// requests under /api/v1/ui/* must echo it in X-RP-CSRF and match the
// cookie (constant-time). An attacker on another origin can neither
// set nor read our cookie, so they can't satisfy both halves.

const CSRF_HEADER = 'x-rp-csrf'
const CSRF_LIFETIME_S = 60 * 60 * 24 * 30 // 30 days

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}

export const csrfIssueHandler = createMiddleware<HonoApp>(async (c) => {
  const cookieName = c.var.env.MONEY_CSRF_COOKIE_NAME
  const existing = readCookie(c.req.header('cookie') ?? '', cookieName)
  const token =
    existing && /^[A-Za-z0-9_-]{40,}$/.test(existing) ? existing : generateCsrfToken()
  c.header(
    'Set-Cookie',
    buildSetCookie(cookieName, token, { maxAge: CSRF_LIFETIME_S, httpOnly: false, secure: c.var.env.NODE_ENV === 'production' }),
  )
  return c.json({ ok: true, csrfToken: token })
})

// Mount on /api/v1/ui/* for non-safe methods. GET/HEAD/OPTIONS are
// exempt (must stay side-effect-free).
export function requireCsrf() {
  return createMiddleware<HonoApp>(async (c, next) => {
    const method = c.req.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    const cookieValue = readCookie(c.req.header('cookie') ?? '', c.var.env.MONEY_CSRF_COOKIE_NAME)
    const headerValue = c.req.header(CSRF_HEADER)
    if (!cookieValue || !headerValue || !constantTimeEqual(cookieValue, headerValue)) {
      throw errors.csrfInvalid()
    }
    await next()
  })
}

export { CSRF_HEADER }
