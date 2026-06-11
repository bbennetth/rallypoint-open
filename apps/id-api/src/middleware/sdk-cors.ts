import { createMiddleware } from 'hono/factory'
import type { HonoApp } from '../context.js'

// CORS for /api/v1/sdk/* per docs/design/api-namespaces-cors.md.
//
// The SDK namespace is bearer-token only. CORS is allowlist-based:
//   - Origins are configured via SDK_CORS_ALLOWED_ORIGINS (comma-
//     separated). `*` enables echo-any-origin for local dev only.
//   - Access-Control-Allow-Origin is the echoed Origin, set ONLY on
//     an allowlist match; otherwise omitted so the browser rejects.
//   - Access-Control-Allow-Credentials is deliberately NEVER set —
//     bearer tokens don't ride on cookies, and omitting it prevents
//     accidental cookie-credential confusion.

function parseAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function sdkCors() {
  return createMiddleware<HonoApp>(async (c, next) => {
    const allowlist = parseAllowlist(c.var.env.SDK_CORS_ALLOWED_ORIGINS)
    const wildcard = allowlist.includes('*')
    const origin = c.req.header('origin')
    // `origin` truthiness narrows it to string for the header sets.
    const allowedOrigin =
      origin && (wildcard || allowlist.includes(origin)) ? origin : null

    // Preflight is answered here and short-circuits before the
    // route's bearer-auth gate (preflight requests carry no
    // Authorization header by spec).
    if (c.req.method === 'OPTIONS') {
      const headers = new Headers({ Vary: 'Origin' })
      if (allowedOrigin) {
        headers.set('Access-Control-Allow-Origin', allowedOrigin)
        headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE')
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        headers.set('Access-Control-Max-Age', '600')
      }
      return new Response(null, { status: 204, headers })
    }

    if (allowedOrigin) {
      c.header('Access-Control-Allow-Origin', allowedOrigin)
      c.header('Vary', 'Origin')
    }
    await next()
  })
}
