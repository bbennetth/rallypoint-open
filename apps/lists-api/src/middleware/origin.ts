import { createMiddleware } from 'hono/factory'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Origin allowlist for /api/v1/ui/*, ported from apps/events-api. A
// missing Origin is allowed (curl / server-side / same-origin GET
// don't send it; CSRF is the real cross-site defense). A present
// Origin must equal LISTS_UI_ORIGIN, else 403.

export function requireAllowedOrigin() {
  return createMiddleware<HonoApp>(async (c, next) => {
    const origin = c.req.header('origin')
    if (!origin) return next()
    if (origin !== c.var.env.LISTS_UI_ORIGIN) {
      throw errors.forbidden(`Origin not allowed: ${origin}`)
    }
    await next()
  })
}
