import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildMemoryRepos } from '../repos/memory.js'
import type { Services } from '../services/types.js'
import type { ListsClient } from '@rallypoint/lists-client'
import type { EventsClient } from '@rallypoint/events-client'

// Unit tests for the upgraded requireAllowedOrigin middleware (E1 #19).
// Uses memory repos and stubbed services — no D1 required.
// Mirrors apps/id-api/src/middleware/origin.test.ts in shape.

const ENV = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  PLANNER_UI_ORIGIN: 'https://planner.rallypt.app',
})

const nullLists = new Proxy({}, { get: () => async () => [] }) as unknown as ListsClient
const nullEvents = new Proxy({}, { get: () => async () => [] }) as unknown as EventsClient

const stubServices: Services = {
  idClient: {
    verifyRpidBearer: async () => ({ ok: false as const, revoked: true as const }),
    signoutRpidBearer: async () => {},
  },
  rpidSso: {
    exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
  },
  profiles: { lookup: async () => null },
  settings: {
    get: async () => ({}),
    patch: async (_u, _n, p) => p,
  },
  listsClient: nullLists,
  eventsClient: nullEvents,
  webPush: {
    send: async () => ({ ok: false, expired: false }),
  },
}

function build() {
  return buildApp({
    env: ENV,
    repos: buildMemoryRepos(),
    services: stubServices,
  })
}

describe('Origin middleware — /api/v1/ui/* (E1 #19)', () => {
  it('allows GET requests without an Origin header (curl, server-side)', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/csrf')
    // 200 = origin gate passed; the CSRF handler responds.
    expect(res.status).toBe(200)
  })

  it('rejects POST without an Origin header — 403 forbidden', async () => {
    const app = build()
    // /signout is a POST under /api/v1/ui/* that runs even without a session.
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('forbidden')
    expect(body.error?.message).toMatch(/origin/i)
  })

  it.each(['PUT', 'PATCH', 'DELETE'] as const)(
    'rejects %s without an Origin header — 403 forbidden',
    async (method) => {
      const app = build()
      // Hit a path that doesn't exist on a real route — the origin middleware
      // fires BEFORE routing, so the 403 is still observable.
      const res = await app.request('/api/v1/ui/does-not-exist', { method })
      expect(res.status).toBe(403)
    },
  )

  it('allows POST with Origin matching PLANNER_UI_ORIGIN — passes origin gate, reaches CSRF check', async () => {
    const app = build()
    const csrf = 'csrf_test_token_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: {
        // Match origin — origin gate must pass.
        origin: 'https://planner.rallypt.app',
        // Satisfy CSRF double-submit so the request reaches the handler.
        cookie: `${ENV.PLANNER_CSRF_COOKIE_NAME}=${csrf}`,
        'x-rp-csrf': csrf,
      },
    })
    // Signout with no session → 204 no-op. The 403 from origin middleware
    // would have a code of 'forbidden'; a CSRF failure would be
    // 'csrf_token_invalid'. 204 proves origin + CSRF both passed.
    expect(res.status).toBe(204)
  })

  it('rejects POST with a mismatched Origin — 403 forbidden', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/signout', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('forbidden')
  })

  it('rejects GET with a mismatched Origin — allowlist check applies to safe methods too', async () => {
    const app = build()
    // Present Origin on a GET — the allowlist check fires regardless of method.
    const res = await app.request('/api/v1/ui/csrf', {
      headers: { origin: 'https://evil.example' },
    })
    // Mismatched Origin on a GET is still 403 (allowlist applies on any method).
    expect(res.status).toBe(403)
  })

  it('allows GET with the correct Origin', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/csrf', {
      headers: { origin: 'https://planner.rallypt.app' },
    })
    expect(res.status).toBe(200)
  })

  it('does NOT apply to /api/v1/health', async () => {
    const app = build()
    const res = await app.request('/api/v1/health', {
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(200)
  })
})
