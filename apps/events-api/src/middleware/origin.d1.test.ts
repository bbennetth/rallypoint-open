import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildMemoryRepos } from '../repos/memory.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from '../routes/_test-services.js'

// Integration tests for the require-Origin gate on /api/v1/ui/* (E1 #19
// follow-up). Ports the same assertions as id-api's origin.test.ts but
// adapted for events-api: no PUBLIC_BASE_URL (events-api serves no inline
// HTML pages), single allowlisted origin is EVENTS_UI_ORIGIN.

const ENV = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  EVENTS_UI_ORIGIN: 'https://events.rallypt.app',
})

const services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
    batchLookupUsers: async () => [],
  },
  rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
  rpidReauth: { verify: async () => ({ ok: true as const }) },
  objectStore: makeStubObjectStore(),
  listsClient: makeNoopListsClient(),
  moneyClient: makeNoopMoneyClient(),
  weather: {
    getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
  },
  settings: {
    get: async () => ({}),
    patch: async (_u: string, _n: string, patch: Record<string, unknown>) => patch,
  },
}

function build() {
  return buildApp({
    env: ENV,
    repos: buildMemoryRepos(),
    services,
  })
}

// The CSRF cookie must be present for the requireCsrf middleware that runs
// after the origin gate. The origin gate fires first and 403s before CSRF
// is evaluated when Origin is bad — this cookie is only needed for the
// "right Origin" cases so those reach the actual handler.
const CSRF_COOKIE = `rpe_csrf=csrf_test_token_aaaaaa`
const CSRF_HEADER = 'csrf_test_token_aaaaaa'

describe('Origin middleware — /api/v1/ui/* (events-api E1 #19)', () => {
  it('allows GET requests without an Origin header (curl, server-side)', async () => {
    const app = build()
    // GET /api/v1/ui/events returns 401 (no session) but NOT 403 from origin.
    const res = await app.request('/api/v1/ui/events')
    expect(res.status).not.toBe(403)
  })

  it('rejects POST without an Origin header — 403 forbidden', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/events', {
      method: 'POST',
      headers: {
        cookie: CSRF_COOKIE,
        'x-rp-csrf': CSRF_HEADER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Test', timezone: 'UTC' }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('forbidden')
    expect(body.error?.message).toMatch(/origin/i)
  })

  it.each(['PUT', 'PATCH', 'DELETE'] as const)(
    'rejects %s without an Origin header — 403',
    async (method) => {
      const app = build()
      const res = await app.request('/api/v1/ui/does-not-exist', { method })
      expect(res.status).toBe(403)
    },
  )

  it('allows POST with Origin matching EVENTS_UI_ORIGIN — passes origin gate', async () => {
    const app = build()
    // This will 401 (no session) or 403 CSRF — but NOT 403 from origin.
    // Origin gate passes; the next error is from the CSRF or session layer.
    const res = await app.request('/api/v1/ui/events', {
      method: 'POST',
      headers: {
        origin: 'https://events.rallypt.app',
        cookie: CSRF_COOKIE,
        'x-rp-csrf': CSRF_HEADER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Test', timezone: 'UTC' }),
    })
    // Origin gate did not 403 — downstream middleware may 401/403 for
    // other reasons (session, CSRF), but origin-forbidden is not the cause.
    expect(res.status).not.toBe(403)
  })

  it('rejects POST with a wrong Origin — 403 forbidden', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/events', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example.com',
        cookie: CSRF_COOKIE,
        'x-rp-csrf': CSRF_HEADER,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Test', timezone: 'UTC' }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('forbidden')
  })

  it('rejects GET with a wrong Origin — 403 forbidden', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/events', {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('forbidden')
  })

  it('does NOT apply to /api/v1/sdk/*', async () => {
    const app = build()
    // SDK routes are not behind the origin gate; evil Origin is fine there.
    const res = await app.request('/api/v1/sdk/events', {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.status).not.toBe(403)
  })

  it('does NOT apply to /api/v1/health', async () => {
    const app = build()
    const res = await app.request('/api/v1/health', {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(200)
  })
})
