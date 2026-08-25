import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'

const ENV = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  UI_ORIGIN: 'https://id.rallypt.app',
  PUBLIC_BASE_URL: 'https://api.rallypt.app',
})

function build() {
  return buildApp({
    env: ENV,
    repos: buildInMemoryRepos(),
    services: {
      mailer: createLogMailer({ sink: () => undefined }),
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    },
  })
}

describe('Origin middleware — /api/v1/ui/*', () => {
  it('allows GET requests without an Origin header (curl, server-side)', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/csrf')
    expect(res.status).toBe(200)
  })

  it('rejects POST without an Origin header (E1 #19 — closes CSRF defense-in-depth gap)', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('forbidden')
    expect(body.error?.message).toMatch(/origin/i)
  })

  it.each(['PUT', 'PATCH', 'DELETE'] as const)(
    'rejects %s without an Origin header',
    async (method) => {
      const app = build()
      // Use a route that's mounted under /api/v1/ui/ — /api/v1/ui/csrf is GET
      // and /api/v1/ui/signout is POST; for PUT/PATCH/DELETE we hit a path
      // that doesn't exist on a real route. The origin middleware fires
      // BEFORE routing, so the 403 is still observable.
      const res = await app.request('/api/v1/ui/does-not-exist', {
        method,
      })
      expect(res.status).toBe(403)
    },
  )

  it('allows requests with Origin matching UI_ORIGIN', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/csrf', {
      headers: { origin: 'https://id.rallypt.app' },
    })
    expect(res.status).toBe(200)
  })

  it('allows requests with Origin matching PUBLIC_BASE_URL (slice-2 inline page)', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/csrf', {
      headers: { origin: 'https://api.rallypt.app' },
    })
    expect(res.status).toBe(200)
  })

  it('rejects requests with an off-origin header (403 forbidden)', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/csrf', {
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('forbidden')
  })

  it('does NOT apply to /api/v1/sdk/*', async () => {
    const app = build()
    const res = await app.request('/api/v1/sdk/signout', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    // signout returns 200 unconditionally on the SDK side (it just
    // tries to delete a bearer's row); the point is the response is
    // NOT 403-from-origin.
    expect(res.status).not.toBe(403)
  })

  it('does NOT apply to /api/v1/health', async () => {
    const app = build()
    const res = await app.request('/api/v1/health', {
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(200)
  })
})
