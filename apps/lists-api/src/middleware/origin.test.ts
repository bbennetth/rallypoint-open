import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildMemoryRepos } from '../repos/memory.js'
import type { Services } from '../services/types.js'

// Unit tests for the require-Origin gate on /api/v1/ui/* (E1 #19).
// Uses in-memory repos + stub services — no D1 needed because the
// origin middleware fires before routing + session resolution.

const ENV = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  LISTS_UI_ORIGIN: 'https://lists.rallypt.app',
})

const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
  },
  rpidSso: {
    exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
  },
  settings: {
    get: async () => ({}),
    patch: async (_u: string, _n: string, p: Record<string, unknown>) => p,
  },
}

function build() {
  return buildApp({
    env: ENV,
    repos: buildMemoryRepos(),
    services,
  })
}

describe('Origin middleware — /api/v1/ui/*', () => {
  it('allows GET requests without an Origin header (curl, server-side)', async () => {
    const app = build()
    // GET /api/v1/ui/csrf is a public endpoint under /api/v1/ui/*
    const res = await app.request('http://localhost/api/v1/ui/csrf')
    expect(res.status).not.toBe(403)
  })

  it('rejects POST without an Origin header (E1 #19 — require-origin hardening)', async () => {
    const app = build()
    // POST /api/v1/ui/signout is under /api/v1/ui/*; origin fires before session
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
      // Use a path under /api/v1/ui/ — origin middleware fires before routing,
      // so even a non-existent route returns 403 (not 404).
      const res = await app.request('/api/v1/ui/does-not-exist', {
        method,
      })
      expect(res.status).toBe(403)
    },
  )

  it('allows requests with Origin matching LISTS_UI_ORIGIN', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/csrf', {
      headers: { origin: 'https://lists.rallypt.app' },
    })
    expect(res.status).not.toBe(403)
  })

  it('rejects requests with a wrong Origin header (403 forbidden)', async () => {
    const app = build()
    const res = await app.request('/api/v1/ui/csrf', {
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('forbidden')
  })

  it('does NOT apply to /api/v1/sdk/* (missing origin is NOT a 403 from the origin gate)', async () => {
    const app = build()
    // POST to SDK surface without origin header — origin gate must not fire here;
    // the SDK key gate fires instead (different message: "App API authentication required.")
    const res = await app.request('/api/v1/sdk/does-not-exist', {
      method: 'POST',
    })
    // sdkKeyGate fires with "App API authentication required.", NOT the origin message.
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.message).not.toMatch(/origin/i)
  })

  it('does NOT apply to /api/v1/health', async () => {
    const app = build()
    const res = await app.request('/api/v1/health', {
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(200)
  })
})
