import { randomBytes } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import type { HonoApp } from '../context.js'
import { constantTimeEqual, readCookie, buildSetCookie } from '@rallypoint/crypto'
import { ApiError, errors } from '../errors.js'

// CSRF — double-submit token per docs/design/cookies-csrf.md.
//
//   1. GET /api/v1/ui/csrf issues a random 32-byte base64url
//      token, sets it as the CSRF cookie (NOT HttpOnly so the
//      hosted UI JS can read it), and returns it in the body
//      for convenience.
//   2. State-changing POST/PATCH/DELETE under /api/v1/ui/*
//      require the cookie AND a matching X-RP-CSRF header.
//      Constant-time compared.
//
// The "double submit" pattern works because an attacker on a
// different origin cannot set our cookie (SameSite=Lax +
// optionally __Host- prefix), and cannot read our cookie (same-
// origin policy), so they cannot satisfy both halves of the
// check simultaneously. CSP + Origin gate (#18) close the rest.

const CSRF_HEADER = 'x-rp-csrf'
const CSRF_LIFETIME_S = 60 * 60 * 24 * 30 // 30 days, matches session

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}

// Issued by GET /api/v1/ui/csrf. The handler is intentionally
// tiny — it just sets-or-rotates the cookie and returns the
// value. Idempotent.
export const csrfIssueHandler = createMiddleware<HonoApp>(async (c) => {
  const cookieName = c.var.env.CSRF_COOKIE_NAME
  const existing = readCookie(c.req.header('cookie') ?? '', cookieName)
  const token = existing && /^[A-Za-z0-9_-]{40,}$/.test(existing)
    ? existing
    : generateCsrfToken()
  c.header(
    'Set-Cookie',
    buildSetCookie(cookieName, token, { maxAge: CSRF_LIFETIME_S, httpOnly: false, secure: c.var.env.NODE_ENV === 'production' }),
  )
  return c.json({ ok: true, csrfToken: token })
})

// Mount as middleware on /api/v1/ui/* for non-GET methods.
// GET/HEAD/OPTIONS are exempt per HTTP semantics (must remain
// side-effect-free; if any of ours aren't, that's the bug, not
// the CSRF rule).
export function requireCsrf() {
  return createMiddleware<HonoApp>(async (c, next) => {
    const method = c.req.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next()
    }
    const cookieName = c.var.env.CSRF_COOKIE_NAME
    const cookieValue = readCookie(c.req.header('cookie') ?? '', cookieName)
    const headerValue = c.req.header(CSRF_HEADER)
    if (!cookieValue || !headerValue) {
      throw errors.csrfInvalid()
    }
    if (!constantTimeEqual(cookieValue, headerValue)) {
      throw errors.csrfInvalid()
    }
    await next()
  })
}

// Re-export for tests / unusual call sites.
export { CSRF_HEADER }

// Hook so SDK / non-browser callers can bypass CSRF cleanly if
// they ever hit a UI route by mistake. Not used in V1.
export function bypassCsrfForRequest(_c: never): never {
  throw new ApiError({
    code: 'csrf_token_invalid',
    message: 'CSRF bypass is not enabled.',
    status: 403,
  })
}
