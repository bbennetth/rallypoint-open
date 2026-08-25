import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildMemoryRepos } from '../repos/memory.js'

// Unit tests for the require-Origin middleware gate (E1 #19 rollout).
// Verify the state-changing-method hardening added in the money-api port
// of apps/id-api/src/middleware/origin.ts.
//
// Uses in-memory repos + stub services so no D1/Miniflare harness needed.

const ENV = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  MONEY_UI_ORIGIN: 'https://money.rallypt.app',
})

const noopObjectStore = {
  async put() { throw new Error('origin tests should not call objectStore') },
  async get() { throw new Error('origin tests should not call objectStore') },
  async headObject() { return null },
  async deleteObject() {},
}

function build() {
  return buildApp({
    env: ENV,
    repos: buildMemoryRepos(),
    services: {
      idClient: {
        verifyRpidBearer: async () => ({ ok: false as const, revoked: true as const }),
        signoutRpidBearer: async () => {},
      },
      rpidSso: {
        exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
      },
      profiles: {
        lookup: async () => null,
      },
      settings: {
        get: async () => ({}),
        patch: async (_u, _n, p) => p,
      },
      objectStore: noopObjectStore,
    },
  })
}

describe('Origin middleware — /api/v1/ui/* (E1 #19 hardening)', () => {
  it('allows GET requests without an Origin header (curl, server-side)', async () => {
    const app = build()
    // CSRF endpoint is a safe public GET — no auth needed.
    const res = await app.request('http://localhost/api/v1/ui/csrf')
    expect(res.status).toBe(200)
  })

  it('rejects POST without an Origin header → 403', async () => {
    const app = build()
    // /signout is a POST under /api/v1/ui/ and always mounts before auth,
    // so the origin check fires before the session check.
    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('forbidden')
    expect(body.error?.message).toMatch(/origin/i)
  })

  it.each(['PUT', 'PATCH', 'DELETE'] as const)(
    'rejects %s without an Origin header → 403',
    async (method) => {
      const app = build()
      // Hit a path that doesn't resolve to a real route — the origin
      // middleware runs before routing so 403 is still observable.
      const res = await app.request('http://localhost/api/v1/ui/does-not-exist', {
        method,
      })
      expect(res.status).toBe(403)
    },
  )

  it('rejects POST with a wrong Origin header → 403', async () => {
    const app = build()
    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('forbidden')
  })

  it('allows POST with the correct MONEY_UI_ORIGIN → origin gate passes (next middleware runs)', async () => {
    const app = build()
    // /signout with correct origin passes the origin gate and proceeds to
    // the CSRF check. Without a CSRF cookie the CSRF middleware returns 403
    // with code 'csrf_token_invalid' — distinct from the origin gate's
    // 'forbidden' code. This proves the request continued past the origin gate.
    const res = await app.request('http://localhost/api/v1/ui/signout', {
      method: 'POST',
      headers: { origin: 'https://money.rallypt.app' },
    })
    const body = (await res.json()) as { error?: { code?: string } }
    // Origin gate passes → CSRF gate fires next → csrf_token_invalid
    expect(body.error?.code).toBe('csrf_token_invalid')
  })

  it('does NOT apply to /api/v1/sdk/* (SDK surface is key-gated, not origin-gated)', async () => {
    const app = build()
    // An SDK POST with no origin at all should be blocked by the SDK key
    // gate, not the origin middleware. The key check returns 403 with
    // code 'forbidden' (no key) or 404 (no keys configured). Either way
    // the error message must NOT mention "Origin".
    const res = await app.request('/api/v1/sdk/does-not-exist', {
      method: 'POST',
      // Deliberately omit Origin — origin gate must not fire here.
    })
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    // If origin gate fired the message would say "Origin header required ...".
    expect(body.error?.message ?? '').not.toMatch(/origin/i)
  })

  it('does NOT apply to /api/v1/health', async () => {
    const app = build()
    const res = await app.request('/api/v1/health', {
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(200)
  })
})
