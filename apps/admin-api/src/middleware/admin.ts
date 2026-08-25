import { createMiddleware } from 'hono/factory'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { isAdminUser } from '../lib/admin-allowlist.js'

// The admin gate. Mount AFTER requireSession(): a valid session alone never
// grants access — the session user must also appear in the ADMIN_USER_IDS
// comma-separated allowlist (empty/absent = nobody). 403s carry the standard
// error envelope so the SPA can render a friendly "not an admin" state.

export function requireAdmin() {
  return createMiddleware<HonoApp>(async (c, next) => {
    const session = c.var.session
    // Defense-in-depth: requireSession() must have run first. A missing
    // session here is a wiring bug, not an unauthenticated user.
    if (!session) throw errors.unauthorized()
    if (!isAdminUser(session.userId, c.var.env.ADMIN_USER_IDS)) {
      throw errors.forbidden('Admin access required.')
    }
    await next()
  })
}
