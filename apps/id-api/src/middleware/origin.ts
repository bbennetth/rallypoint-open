import { createMiddleware } from 'hono/factory'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Origin allowlist for /api/v1/ui/* per docs/design/api-namespaces-cors.md.
//
// Rule:
//   - If the Origin header is missing, allow the request through
//     (curl, server-side calls, some same-origin navigations
//     don't send Origin). CSRF middleware is the real defense
//     against cross-site abuse; this is defense-in-depth on top.
//   - If Origin IS present, it must match either UI_ORIGIN (the
//     hosted UI) or PUBLIC_BASE_URL (the API's own origin — for
//     the slice-2 inline /verify-email page which is served by
//     the API and POSTs back to itself).
//   - Mismatch → 403 forbidden.

export function requireAllowedOrigin() {
  return createMiddleware<HonoApp>(async (c, next) => {
    const origin = c.req.header('origin')
    if (!origin) {
      // No Origin header — allow. Browsers always send Origin on
      // cross-origin POST/PATCH/DELETE, so a missing Origin from
      // a browser is benign (same-origin GET, etc.). Non-browser
      // clients lack Origin too.
      return next()
    }
    const allowed = new Set<string>([c.var.env.UI_ORIGIN, c.var.env.PUBLIC_BASE_URL])
    if (!allowed.has(origin)) {
      throw errors.forbidden(`Origin not allowed: ${origin}`)
    }
    await next()
  })
}
