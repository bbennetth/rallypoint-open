import type { MiddlewareHandler } from 'hono'
import { constantTimeEqual, readCookie, buildSetCookie } from '@rallypoint/crypto'

// CSRF double-submit (docs/design/cookies-csrf.md). GET /api/v1/ui/csrf issues
// a random token in a JS-readable cookie + body; state-changing requests under
// /api/v1/ui/* must echo it in X-RP-CSRF and match the cookie (constant-time).
// An attacker on another origin can neither set nor read our cookie, so they
// can't satisfy both halves. Copy-pasted across all seven HTTP APIs (differing
// only by the cookie-name env var); it lives here once now, configured via
// createRequireCsrf / createCsrfIssueHandler.

export const CSRF_HEADER = 'x-rp-csrf'
const CSRF_LIFETIME_S = 60 * 60 * 24 * 30 // 30 days, matches session
// A freshly-issued token is 43 base64url chars; accept anything ≥40 as a
// well-shaped existing cookie so the issuer echoes it rather than rotating.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,}$/

// WebCrypto-only (no node:crypto / nodejs_compat dependency for this module) —
// the Workers runtime provides crypto.getRandomValues and btoa natively.
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

export interface CsrfMiddlewareConfig {
  /** Env key holding the CSRF cookie name, e.g. `'EVENTS_CSRF_COOKIE_NAME'`. */
  cookieNameEnvKey: string
  /** App error factory — thrown so the app's error handler formats it. */
  errors: { csrfInvalid(): Error }
}

interface CsrfCtxVars {
  env: Record<string, unknown>
}

// Issued by GET /api/v1/ui/csrf: sets-or-rotates the (non-HttpOnly) cookie and
// returns the value. Idempotent — a well-shaped existing cookie is echoed back
// unchanged so concurrent tabs don't rotate each other out.
export function createCsrfIssueHandler(config: CsrfMiddlewareConfig): MiddlewareHandler {
  return async (c) => {
    const vars = c.var as unknown as CsrfCtxVars
    const cookieName = String(vars.env[config.cookieNameEnvKey])
    const existing = readCookie(c.req.header('cookie') ?? '', cookieName)
    const token = existing && TOKEN_SHAPE.test(existing) ? existing : generateCsrfToken()
    c.header(
      'Set-Cookie',
      buildSetCookie(cookieName, token, {
        maxAge: CSRF_LIFETIME_S,
        httpOnly: false,
        secure: vars.env.NODE_ENV === 'production',
      }),
    )
    return c.json({ ok: true, csrfToken: token })
  }
}

// Mount on /api/v1/ui/* for non-safe methods. GET/HEAD/OPTIONS are exempt
// (must stay side-effect-free).
export function createRequireCsrf(config: CsrfMiddlewareConfig): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    const vars = c.var as unknown as CsrfCtxVars
    const cookieName = String(vars.env[config.cookieNameEnvKey])
    const cookieValue = readCookie(c.req.header('cookie') ?? '', cookieName)
    const headerValue = c.req.header(CSRF_HEADER)
    if (!cookieValue || !headerValue || !constantTimeEqual(cookieValue, headerValue)) {
      throw config.errors.csrfInvalid()
    }
    await next()
  }
}
