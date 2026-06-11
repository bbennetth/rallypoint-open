import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import { constantTimeEqual } from '@rallypoint/crypto'
import { ANTI_FINGERPRINT_NOT_FOUND } from '@rallypoint/shared'
import { ApiError, errors } from '../errors.js'

// Env-gated admin namespace. ADMIN_TOKEN env must be set AND
// match the Authorization header for any /api/v1/admin/* call.
// No UI — curl-from-localhost workflow. Slice 5.5 expands with
// the /admin/users lookup.

export const adminRoutes = new Hono<HonoApp>()
  .use('/api/v1/admin/*', async (c, next) => {
    const token = c.var.env.ADMIN_TOKEN
    if (!token) {
      // ADMIN_TOKEN unset = admin namespace disabled. Return 404
      // (the docs/code comment said 404 already; the previous
      // 403 was a bug — P4.3). 404 makes attacker fingerprinting
      // strictly harder: an unconfigured admin endpoint looks
      // identical to a missing route.
      throw new ApiError({ ...ANTI_FINGERPRINT_NOT_FOUND, status: 404 })
    }
    const header = c.req.header('authorization') ?? ''
    const supplied = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!supplied || !constantTimeEqual(supplied, token)) {
      throw errors.forbidden('Admin authentication required.')
    }
    await next()
  })
  // Build identity for operators. version + commit live behind
  // ADMIN_TOKEN per P4.1 (commit SHA was a fingerprinting risk
  // when exposed publicly via /health and /version).
  .get('/api/v1/admin/version', (c) =>
    c.json({
      version: c.var.env.BUILD_VERSION,
      commit: c.var.env.BUILD_COMMIT,
      env: c.var.env.NODE_ENV,
    }),
  )
  .get('/api/v1/admin/audit', async (c) => {
    const url = new URL(c.req.url)
    const userId = url.searchParams.get('userId') ?? undefined
    const eventType = url.searchParams.get('eventType') ?? undefined
    const limit = Number(url.searchParams.get('limit') ?? '100')
    const tenantId = url.searchParams.get('tenantId') ?? 'rallypoint'
    const events = await c.var.repos.audit.list({
      tenantId,
      ...(userId ? { userId: userId as `user_${string}` } : {}),
      ...(eventType ? { eventType } : {}),
      limit,
    })
    return c.json({ events })
  })
  // Look up a user by email OR user_id. Read-only.
  // Returns the full DB row (admin-only — no enumeration concerns).
  .get('/api/v1/admin/users', async (c) => {
    const url = new URL(c.req.url)
    const tenantId = url.searchParams.get('tenantId') ?? 'rallypoint'
    const email = url.searchParams.get('email')
    const userId = url.searchParams.get('userId')

    if (!email && !userId) {
      // Throw through the standard error envelope so it picks up
      // the error-handler logging + X-RP-Request-Id header (#26).
      throw new ApiError({
        code: 'admin_query_required',
        message: 'Specify one of ?email= or ?userId=.',
        status: 400,
      })
    }

    const user = userId
      ? await c.var.repos.users.findById(userId as `user_${string}`)
      : await c.var.repos.users.findByEmail(tenantId, email!.toLowerCase())

    if (!user) return c.json({ user: null })

    const authMethods = await c.var.repos.authMethods.findByUserAndKind(user.id, 'password')
    return c.json({
      user: {
        ...user,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        deletedAt: user.deletedAt?.toISOString() ?? null,
      },
      hasPasswordMethod: authMethods !== null,
    })
  })
