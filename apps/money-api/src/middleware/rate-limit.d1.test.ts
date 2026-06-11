import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'

// D1 integration tests for the POST /api/v1/ui/sso/exchange rate-limiter.
// The limiter fires BEFORE the state-cookie check, so we can drive it with
// any valid CSRF headers and observe 429 on the 11th request.
// A different IP must still be allowed after the first IP is exhausted.

const CSRF = 'csrf_rl_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const noopObjectStore: Services['objectStore'] = {
  async put() {
    throw new Error('rate-limit tests should not call objectStore')
  },
  async get() {
    throw new Error('rate-limit tests should not call objectStore')
  },
  async headObject() {
    return null
  },
  async deleteObject() {},
}

describe('D1 integration — sso/exchange rate limiter', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  // Mock the SSO exchange so requests that slip past the rate-limiter
  // (first 10) don't fail for a different reason — they'll fail on the
  // missing / mismatched state cookie before reaching RPID, but the
  // rate-limiter fires first so request 11 is the one we care about.
  // We don't need the exchange to succeed for this test.
  const exchangeMock = vi.fn().mockResolvedValue({ ok: false as const, reason: 'invalid' as const })

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: { exchange: exchangeMock },
    profiles: { lookup: async () => null },
    settings: {
      get: async () => ({}),
      patch: async (_u: string, _n: string, patch: Record<string, unknown>) => patch,
    },
    objectStore: noopObjectStore,
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  function exchangeHeaders(ip: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      // CSRF double-submit: cookie + header must match.
      cookie: `${envVars.MONEY_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'x-forwarded-for': ip,
    }
  }

  function exchangeBody(): string {
    // State won't match any cookie (we only set the CSRF cookie above),
    // so requests 1–10 will 400 on state mismatch — but that is fine:
    // the rate-limiter fires first. Request 11 must 429 before even
    // checking the state cookie.
    return JSON.stringify({ code: 'test-code', state: 'state_does_not_match' })
  }

  it('allows up to 10 exchange attempts per IP within 10 minutes', async () => {
    const ip = '203.0.113.20'
    for (let i = 0; i < 10; i++) {
      const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
        method: 'POST',
        headers: exchangeHeaders(ip),
        body: exchangeBody(),
      })
      // The limiter passes; the request proceeds and fails on state
      // mismatch (400) or other validation — anything other than 429.
      expect(res.status).not.toBe(429)
    }
  })

  it('returns 429 with Retry-After on the 11th attempt from the same IP', async () => {
    const ip = '203.0.113.20'
    // The 10 requests above already consumed the window for this IP.
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: exchangeHeaders(ip),
      body: exchangeBody(),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    const body = (await res.json()) as { error?: { code?: string; details?: { retry_after_seconds?: number } } }
    expect(body.error?.code).toBe('rate_limited')
    expect(Number(body.error?.details?.retry_after_seconds)).toBeGreaterThan(0)
  })

  it('a different IP is unaffected after the first IP is exhausted', async () => {
    const freshIp = '198.51.100.42'
    const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
      method: 'POST',
      headers: exchangeHeaders(freshIp),
      body: exchangeBody(),
    })
    // The limiter allows this IP; the request fails on state mismatch.
    expect(res.status).not.toBe(429)
  })
})
