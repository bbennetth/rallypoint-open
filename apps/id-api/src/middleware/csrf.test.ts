import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'

const ENV = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })

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

const TOKEN = 'csrf-test-token-' + 'x'.repeat(40)

describe('GET /api/v1/ui/csrf — issuer', () => {
  it('returns ok + csrfToken and sets the CSRF cookie', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/csrf')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; csrfToken: string }
    expect(body.ok).toBe(true)
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${ENV.CSRF_COOKIE_NAME}=${body.csrfToken}`)
    expect(setCookie).toContain('Path=/')
    // #351 — Secure is derived from the runtime env.NODE_ENV binding.
    // Tests run with NODE_ENV='test', so the cookie omits Secure.
    expect(setCookie).not.toContain('Secure')
    expect(setCookie).toContain('SameSite=Lax')
    // CSRF cookie must NOT be HttpOnly — JS needs to read it.
    expect(setCookie).not.toContain('HttpOnly')
  })

  it('preserves an existing CSRF cookie (idempotent)', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/csrf', {
      headers: { cookie: `${ENV.CSRF_COOKIE_NAME}=${TOKEN}` },
    })
    const body = (await res.json()) as { csrfToken: string }
    expect(body.csrfToken).toBe(TOKEN)
  })
})

describe('CSRF middleware — /api/v1/ui/* state-changing', () => {
  it('rejects POST without cookie + header (403 csrf_token_invalid)', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/signout', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('csrf_token_invalid')
  })

  it('rejects POST with cookie but missing header', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: { cookie: `${ENV.CSRF_COOKIE_NAME}=${TOKEN}` },
    })
    expect(res.status).toBe(403)
  })

  it('rejects POST with header but missing cookie', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: { 'x-rp-csrf': TOKEN },
    })
    expect(res.status).toBe(403)
  })

  it('rejects POST with mismatched cookie / header', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: {
        cookie: `${ENV.CSRF_COOKIE_NAME}=${TOKEN}`,
        'x-rp-csrf': 'a-different-token-' + 'y'.repeat(40),
      },
    })
    expect(res.status).toBe(403)
  })

  it('accepts POST with matching cookie + header', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: {
        cookie: `${ENV.CSRF_COOKIE_NAME}=${TOKEN}`,
        'x-rp-csrf': TOKEN,
      },
    })
    // signout returns 200 even without a session
    expect(res.status).toBe(200)
  })

  it('exempts GET (no cookie/header required)', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/session')
    // 401 from session-required middleware, NOT 403 from csrf.
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('session_required')
  })

  it('does NOT apply to /api/v1/sdk/*', async () => {
    const app = build()
    const res = await app.request('/api/v1/sdk/session/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'rps_live_nope' }),
    })
    // 401 because the token is bad, NOT 403 from CSRF.
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('bearer_invalid')
  })
})
