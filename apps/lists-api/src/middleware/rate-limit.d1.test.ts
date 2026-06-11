import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'

// D1 integration tests for the per-IP rate-limit on POST /api/v1/ui/sso/exchange.
// The limiter runs BEFORE state-cookie verification, so we can reach the
// rate-limit check with any request shape — no valid state cookie needed.
//
// Policy under test: 10 requests per 10 minutes per IP.

const CSRF = 'csrf_token_value_ratelimit_test_aaaaaaaaaa'

// Minimal services stub — the exchange will fail after the rate-limit
// check passes (sso_state_mismatch), which is fine for these tests.
const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
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
    patch: async (_u: string, _n: string, patch: Record<string, unknown>) => patch,
  },
}

describe('D1 integration — SSO exchange rate limit', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  // Rebuild repos + app before each test so rate-limit buckets start fresh.
  beforeEach(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  function exchangeRequest(ip: string): Promise<Response> {
    return app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        cookie: `${envVars.LISTS_SSO_STATE_COOKIE_NAME}=irrelevant; ${envVars.LISTS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
      },
      body: JSON.stringify({ code: 'c', state: 'irrelevant' }),
    })
  }

  it('allows the first 10 exchange requests from the same IP', async () => {
    const ip = '203.0.113.10'
    for (let i = 0; i < 10; i++) {
      const res = await exchangeRequest(ip)
      // State mismatch (400) means the rate-limit check passed.
      expect(res.status).not.toBe(429)
    }
  })

  it('429s the 11th exchange request from the same IP with Retry-After', async () => {
    const ip = '203.0.113.11'
    for (let i = 0; i < 10; i++) {
      await exchangeRequest(ip)
    }
    const res = await exchangeRequest(ip)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    const body = (await res.json()) as {
      error?: { code?: string; details?: { retry_after_seconds?: number } }
    }
    expect(body.error?.code).toBe('rate_limited')
    expect(body.error?.details?.retry_after_seconds).toBeGreaterThan(0)
  })

  it('a different IP is unaffected after another IP exhausts its bucket', async () => {
    const ipA = '203.0.113.20'
    const ipB = '198.51.100.50'
    for (let i = 0; i < 10; i++) {
      await exchangeRequest(ipA)
    }
    // ipA is now rate-limited
    const resA = await exchangeRequest(ipA)
    expect(resA.status).toBe(429)
    // ipB has a fresh bucket
    const resB = await exchangeRequest(ipB)
    expect(resB.status).not.toBe(429)
  })
})
