import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import type { Env } from '../env.js'
import { requireAllowedOrigin } from './origin.js'
import { errorHandler } from './error-handler.js'

// Regression coverage for the api-kit origin extraction, which lifted admin-api
// from the legacy variant (missing Origin always allowed) to the hardened one
// (state-changing requests must carry an Origin header). admin-api had no
// origin coverage before. A tiny Hono app is enough — the origin middleware
// fires before routing and reads only c.var.env, so no D1/services are needed.

const UI_ORIGIN = 'https://admin.rallypt.app'

function build() {
  const app = new Hono<HonoApp>()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('env', { ADMIN_UI_ORIGIN: UI_ORIGIN } as unknown as Env)
    c.set('requestId', 'test-req')
    await next()
  })
  app.use('/api/v1/ui/*', requireAllowedOrigin())
  app.get('/api/v1/ui/csrf', (c) => c.json({ ok: true }))
  app.post('/api/v1/ui/signout', (c) => c.json({ ok: true }))
  return app
}

describe('admin-api origin middleware — /api/v1/ui/* (hardened)', () => {
  it('allows GET without an Origin header (curl, server-side)', async () => {
    const res = await build().request('/api/v1/ui/csrf')
    expect(res.status).toBe(200)
  })

  it('rejects POST without an Origin header (the admin-api hardening)', async () => {
    const res = await build().request('/api/v1/ui/signout', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('forbidden')
    expect(body.error?.message).toMatch(/origin/i)
  })

  it.each(['PUT', 'PATCH', 'DELETE'] as const)(
    'rejects %s without an Origin header (fires before routing)',
    async (method) => {
      const res = await build().request('/api/v1/ui/does-not-exist', { method })
      expect(res.status).toBe(403)
    },
  )

  it('allows a request whose Origin matches ADMIN_UI_ORIGIN', async () => {
    const res = await build().request('/api/v1/ui/signout', {
      method: 'POST',
      headers: { origin: UI_ORIGIN },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a request with an off-origin header', async () => {
    const res = await build().request('/api/v1/ui/signout', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('forbidden')
  })
})
