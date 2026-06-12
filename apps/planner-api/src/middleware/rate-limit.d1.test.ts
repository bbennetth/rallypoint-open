import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import type { EventsClient } from '@rallypoint/events-client'
import type { ListsClient } from '@rallypoint/lists-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for rate limiting in planner-api.
//
// Strategy for the per-user 60req/60s limit (my-day / upcoming):
//   Rather than issuing 60 requests, we build a fresh InMemoryRateLimitRepo
//   with a one-token policy (limit=1) and inject it into the repos bag.
//   The D1Repos type is used for the sessions repo (real D1) while the
//   rateLimit slot is overridden with an in-memory stub configured at a
//   low threshold — so we need exactly 2 requests to trip the limit.
//   This mirrors the id-api test philosophy: use a small policy-per-test
//   rather than issuing N-1 requests to exhaust a production limit.
//
// For the SSO exchange per-IP test we use the real D1 repo (rate_limits
// table created by migration 0001) to validate end-to-end D1 wiring.
// Limit is 10/600s; we issue 11 requests from the same IP.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

const FAKE_USER = {
  userId: 'user_rl_planner_01',
  email: 'rl-planner@example.com',
  emailVerified: true,
  displayName: 'RL Planner Tester',
  pictureUrl: null,
  username: 'rlplannertester',
  sessionBearer: 'rpid_session_bearer_rl_stub',
  sessionAbsoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
}

function makeNullLists(): ListsClient {
  return {
    listGroups: async () => [],
    listLists: async () => [],
    listItems: async () => [],
    listPersonalTaskLists: async () => [],
  } as unknown as ListsClient
}

function makeNullEvents(): EventsClient {
  return {
    listPersonalEvents: async () => [],
    listUserEvents: async () => [],
    listPlannerGroupEvents: async () => [],
  } as unknown as EventsClient
}

describe('D1 integration — rate limiting', () => {
  let env: Env
  let d1Repos: Repos
  let exchange: ReturnType<typeof vi.fn>

  beforeAll(() => {
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    d1Repos = buildD1Repos(createDb(testEnv.DB))
  })

  // Mint a planner session in the DB and return the raw bearer.
  async function loginAs(userId: string, repos: Repos): Promise<string> {
    const rawBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { PLANNER_SESSION_KEY_V1: env.PLANNER_SESSION_KEY_V1 },
      keyVersion: env.PLANNER_SESSION_KEY_VERSION,
    })
    await repos.sessions.create({
      idHash,
      userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      ipHash: '',
      uaHash: '',
    })
    return rawBearer
  }

  function csrfCookiePair(): string {
    return `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`
  }

  function sessionHeaders(bearer: string): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${csrfCookiePair()}`,
      'x-rp-csrf': CSRF,
    }
  }

  // --- SSO exchange per-IP rate limit (real D1 repo) ---

  describe('POST /sso/exchange — per-IP limit (10/600s, real D1)', () => {
    let app: Hono<HonoApp>

    beforeEach(() => {
      exchange = vi.fn().mockResolvedValue({ ok: true as const, result: FAKE_USER })
      const services: Services = {
        idClient: {
          verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
          signoutRpidBearer: vi.fn().mockResolvedValue(undefined),
        },
        rpidSso: { exchange },
        settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
        profiles: { lookup: async () => null },
        listsClient: makeNullLists(),
        eventsClient: makeNullEvents(),
      }
      // Use the real D1 repos (rate_limits table from migration 0001).
      app = buildApp({ env, logger: undefined, repos: d1Repos, services })
    })

    it('allows the first 10 requests from the same IP and 429s the 11th with Retry-After', async () => {
      const stateNonce = `rl_sso_state_${Date.now()}`
      const ip = '203.0.113.42'

      // Exhaust the limit.
      for (let i = 0; i < 10; i++) {
        exchange.mockResolvedValueOnce({ ok: true as const, result: FAKE_USER })
        const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `${env.PLANNER_SSO_STATE_COOKIE_NAME}=${stateNonce}; ${csrfCookiePair()}`,
            'x-rp-csrf': CSRF,
            'x-forwarded-for': ip,
          },
          body: JSON.stringify({ code: `code-${i}`, state: stateNonce }),
        })
        // State cookie is cleared after each request by the handler, so each
        // subsequent call sees a missing cookie and returns 400 — but the IP
        // token has still been consumed. We only assert status is not 429 here.
        expect(res.status).not.toBe(429)
      }

      // 11th request from the same IP must be rate limited.
      const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${env.PLANNER_SSO_STATE_COOKIE_NAME}=${stateNonce}; ${csrfCookiePair()}`,
          'x-rp-csrf': CSRF,
          'x-forwarded-for': ip,
        },
        body: JSON.stringify({ code: 'code-overflow', state: stateNonce }),
      })
      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).toBeTruthy()
      const body = (await res.json()) as { error?: { code?: string; details?: { retry_after_seconds?: number } } }
      expect(body.error?.code).toBe('rate_limited')
      expect(body.error?.details?.retry_after_seconds).toBeGreaterThan(0)
    })

    it('does not rate-limit a different IP after the first IP is exhausted', async () => {
      const stateNonce = `rl_sso_state_diff_ip_${Date.now()}`
      const ip1 = '203.0.113.50'
      const ip2 = '198.51.100.77'

      // Exhaust ip1 limit.
      for (let i = 0; i < 10; i++) {
        exchange.mockResolvedValueOnce({ ok: true as const, result: FAKE_USER })
        await app.request('http://localhost/api/v1/ui/sso/exchange', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `${env.PLANNER_SSO_STATE_COOKIE_NAME}=${stateNonce}; ${csrfCookiePair()}`,
            'x-rp-csrf': CSRF,
            'x-forwarded-for': ip1,
          },
          body: JSON.stringify({ code: `code-ip1-${i}`, state: stateNonce }),
        })
      }

      // ip1 is exhausted — confirm it.
      const blocked = await app.request('http://localhost/api/v1/ui/sso/exchange', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${env.PLANNER_SSO_STATE_COOKIE_NAME}=${stateNonce}; ${csrfCookiePair()}`,
          'x-rp-csrf': CSRF,
          'x-forwarded-for': ip1,
        },
        body: JSON.stringify({ code: 'overflow', state: stateNonce }),
      })
      expect(blocked.status).toBe(429)

      // ip2 must still be unaffected (different bucket key).
      exchange.mockResolvedValueOnce({ ok: true as const, result: FAKE_USER })
      const fresh = await app.request('http://localhost/api/v1/ui/sso/exchange', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${env.PLANNER_SSO_STATE_COOKIE_NAME}=${stateNonce}; ${csrfCookiePair()}`,
          'x-rp-csrf': CSRF,
          'x-forwarded-for': ip2,
        },
        body: JSON.stringify({ code: 'code-ip2', state: stateNonce }),
      })
      // ip2 should NOT be 429 (may be 204 if state matches, 400 if not — either is fine).
      expect(fresh.status).not.toBe(429)
    })
  })

  // --- Per-user rate limit on GET /my-day (in-memory repo with limit=1) ---
  //
  // We override repos.rateLimit with InMemoryRateLimitRepo pre-loaded to a
  // low limit so we can trip it in 2 requests without the 60-call overhead.

  describe('GET /my-day — per-user limit (in-memory repo, limit=1 override via monkey-patch)', () => {
    it('429s the request that exceeds the per-user limit and sets Retry-After', async () => {
      // Build the app with a real D1 sessions repo but swap rateLimit to an
      // in-memory repo. We wrap it to intercept takeToken and return
      // allowed=false on the second call to simulate a depleted bucket without
      // 60 actual requests.
      let callCount = 0
      const stubbedRateLimit = {
        async takeToken() {
          callCount++
          if (callCount >= 2) {
            return { allowed: false, retryAfterSeconds: 55, blendedCount: 61 }
          }
          return { allowed: true, retryAfterSeconds: 0, blendedCount: callCount }
        },
        async reset() {},
        async pruneOldBuckets() { return 0 },
      }
      const repos: Repos = { sessions: d1Repos.sessions, rateLimit: stubbedRateLimit }

      const services: Services = {
        idClient: {
          verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
          signoutRpidBearer: vi.fn().mockResolvedValue(undefined),
        },
        rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
        settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
        profiles: { lookup: async () => null },
        listsClient: makeNullLists(),
        eventsClient: makeNullEvents(),
      }

      const app = buildApp({ env, logger: undefined, repos, services })
      const userId = 'user_rl_my_day_01'
      const bearer = await loginAs(userId, repos)
      const hdrs = sessionHeaders(bearer)

      // First request: within limit.
      const res1 = await app.request('http://localhost/api/v1/ui/my-day?date=2026-06-10&tz=UTC', {
        headers: hdrs,
      })
      expect(res1.status).toBe(200)

      // Second request: limit exceeded.
      const res2 = await app.request('http://localhost/api/v1/ui/my-day?date=2026-06-10&tz=UTC', {
        headers: hdrs,
      })
      expect(res2.status).toBe(429)
      expect(res2.headers.get('retry-after')).toBe('55')
      const body = (await res2.json()) as { error?: { code?: string; details?: { retry_after_seconds?: number } } }
      expect(body.error?.code).toBe('rate_limited')
      expect(body.error?.details?.retry_after_seconds).toBe(55)
    })
  })

  // --- Per-user rate limit on GET /upcoming (same approach) ---

  describe('GET /upcoming — per-user limit (in-memory repo, stubbed)', () => {
    it('429s when the per-user limit is breached and sets Retry-After', async () => {
      let callCount = 0
      const stubbedRateLimit = {
        async takeToken() {
          callCount++
          if (callCount >= 2) {
            return { allowed: false, retryAfterSeconds: 45, blendedCount: 61 }
          }
          return { allowed: true, retryAfterSeconds: 0, blendedCount: callCount }
        },
        async reset() {},
        async pruneOldBuckets() { return 0 },
      }
      const repos: Repos = { sessions: d1Repos.sessions, rateLimit: stubbedRateLimit }

      const services: Services = {
        idClient: {
          verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
          signoutRpidBearer: vi.fn().mockResolvedValue(undefined),
        },
        rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
        settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
        profiles: { lookup: async () => null },
        listsClient: makeNullLists(),
        eventsClient: makeNullEvents(),
      }

      const app = buildApp({ env, logger: undefined, repos, services })
      const userId = 'user_rl_upcoming_01'
      const bearer = await loginAs(userId, repos)
      const hdrs = sessionHeaders(bearer)

      // First request: within limit.
      const res1 = await app.request('http://localhost/api/v1/ui/upcoming?date=2026-06-10&tz=UTC', {
        headers: hdrs,
      })
      expect(res1.status).toBe(200)

      // Second request: limit exceeded.
      const res2 = await app.request('http://localhost/api/v1/ui/upcoming?date=2026-06-10&tz=UTC', {
        headers: hdrs,
      })
      expect(res2.status).toBe(429)
      expect(res2.headers.get('retry-after')).toBe('45')
      const body = (await res2.json()) as { error?: { code?: string; details?: { retry_after_seconds?: number } } }
      expect(body.error?.code).toBe('rate_limited')
      expect(body.error?.details?.retry_after_seconds).toBe(45)
    })
  })
})
