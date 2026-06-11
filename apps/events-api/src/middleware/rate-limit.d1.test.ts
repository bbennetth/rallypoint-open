import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { ulid } from 'ulid'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services, IdClientService, RpidSsoService } from '../services/types.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from '../routes/_test-services.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for rate limiting on two events-api routes:
//
//   POST /api/v1/ui/sso/exchange  — per-IP, 10 req / 10 min
//   GET  /api/v1/ui/groups/:id/day — per-user, 60 req / 1 min
//
// The SSO exchange tests drive app.request() against the real D1.
// The group-day per-user tests drive app.request() with a stubbed
// rate-limit repo (low threshold) so we don't need 60 real requests.
// The repo-direct bucket-isolation tests validate the D1 repo logic.

const CSRF = 'csrf_token_value_ratelimit_test_aaaaaaaaa'

// ---- helpers -------------------------------------------------------

function exchangeHeaders(state: string, ip?: string): Record<string, string> {
  const h: Record<string, string> = {
    cookie: [
      `${EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      `rpe_sso_state=${state}`,
    ].join('; '),
    'x-rp-csrf': CSRF,
    'content-type': 'application/json',
  }
  if (ip) h['x-forwarded-for'] = ip
  return h
}

// Cookie name — matches what parseEnv derives in test mode.
const EVENTS_CSRF_COOKIE_NAME = 'rpe_csrf'

// ---- suite ---------------------------------------------------------

describe('D1 integration — rate limiting', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  // Spy controls for the SSO exchange stub.
  let exchangeResult: Awaited<ReturnType<RpidSsoService['exchange']>> = {
    ok: false,
    reason: 'invalid',
  }
  let verifyResult: Awaited<ReturnType<IdClientService['verifyRpidBearer']>> = {
    ok: true,
    userId: 'user_rl_test',
  }

  const services: Services = {
    idClient: {
      verifyRpidBearer: async () => verifyResult,
      signoutRpidBearer: async () => {},
      batchLookupUsers: async () => [],
    },
    rpidSso: {
      exchange: async () => exchangeResult,
    },
    rpidReauth: {
      verify: async () => ({ ok: true as const }),
    },
    profiles: { lookup: async () => null },
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

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  beforeEach(() => {
    exchangeResult = { ok: false, reason: 'invalid' }
    verifyResult = { ok: true, userId: 'user_rl_test' }
  })

  // ---- SSO exchange: per-IP rate limit (10 / 10 min) ----------------

  describe('POST /api/v1/ui/sso/exchange — per-IP rate limit', () => {
    it('allows 10 requests from the same IP within the window', async () => {
      const ip = '10.0.0.1'
      // Reset any prior buckets for this IP by resetting via the repo.
      // (Each test run has isolated D1 state from the apply-migrations setup.)
      for (let i = 0; i < 10; i++) {
        const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
          method: 'POST',
          headers: {
            ...exchangeHeaders(`state_ip_allow_${i}`, ip),
          },
          body: JSON.stringify({ code: 'code', state: `state_ip_allow_${i}` }),
        })
        // Exchange fails (state mismatch from SSO stub), but NOT 429.
        expect(res.status).not.toBe(429)
      }
    })

    it('rejects the 11th request from the same IP with 429 + Retry-After', async () => {
      const ip = '10.0.0.2'
      // Send 10 requests to exhaust the bucket (they'll hit sso_code_invalid 400,
      // but the rate-limit counter is incremented before the handler runs).
      for (let i = 0; i < 10; i++) {
        await app.request('http://localhost/api/v1/ui/sso/exchange', {
          method: 'POST',
          headers: exchangeHeaders(`state_ip_11th_${i}`, ip),
          body: JSON.stringify({ code: 'code', state: `state_ip_11th_${i}` }),
        })
      }
      // 11th request must be 429.
      const res = await app.request('http://localhost/api/v1/ui/sso/exchange', {
        method: 'POST',
        headers: exchangeHeaders('state_ip_11th_over', ip),
        body: JSON.stringify({ code: 'code', state: 'state_ip_11th_over' }),
      })
      expect(res.status).toBe(429)
      const retryAfter = res.headers.get('Retry-After')
      expect(retryAfter).toBeTruthy()
      expect(Number(retryAfter)).toBeGreaterThan(0)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('rate_limited')
    })

    it('does not affect a different IP when one IP is exhausted', async () => {
      const exhaustedIp = '10.0.0.3'
      const otherIp = '10.0.0.4'

      // Exhaust the first IP.
      for (let i = 0; i < 10; i++) {
        await app.request('http://localhost/api/v1/ui/sso/exchange', {
          method: 'POST',
          headers: exchangeHeaders(`state_other_ex_${i}`, exhaustedIp),
          body: JSON.stringify({ code: 'code', state: `state_other_ex_${i}` }),
        })
      }
      // First IP is now exhausted.
      const exhaustedRes = await app.request('http://localhost/api/v1/ui/sso/exchange', {
        method: 'POST',
        headers: exchangeHeaders('state_other_ex_over', exhaustedIp),
        body: JSON.stringify({ code: 'code', state: 'state_other_ex_over' }),
      })
      expect(exhaustedRes.status).toBe(429)

      // The other IP is unaffected.
      const otherRes = await app.request('http://localhost/api/v1/ui/sso/exchange', {
        method: 'POST',
        headers: exchangeHeaders('state_other_ip_ok', otherIp),
        body: JSON.stringify({ code: 'code', state: 'state_other_ip_ok' }),
      })
      expect(otherRes.status).not.toBe(429)
    })
  })

  // ---- helpers for per-user (group-day) tests -----------------------

  // Mint a session in D1 and return the raw bearer token.
  async function loginAs(userId: string, reposToUse: Repos): Promise<string> {
    const rawBearer = generateRawToken(EVENTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { EVENTS_SESSION_KEY_V1: envVars.EVENTS_SESSION_KEY_V1 },
      keyVersion: envVars.EVENTS_SESSION_KEY_VERSION,
    })
    await reposToUse.sessions.create({
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

  function sessionHeaders(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
    }
  }

  // Services variant for the per-user HTTP tests: verifyRpidBearer echoes
  // the bearer back as userId (loginAs stores userId as the sealed plaintext,
  // so the decrypted bearer IS the userId).
  const sessionServices: Services = {
    ...services,
    idClient: {
      ...services.idClient,
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    },
  }

  // ---- group-day: per-user rate limit via HTTP (stubbed repo) --------
  // The production limit is 60 req/min, too large to exhaust in a test.
  // We override repos.rateLimit with a stub that returns allowed=false
  // on the second call, so 2 requests trip the limit. Sessions use the
  // real D1 sessions repo; only rateLimit is swapped.

  describe('GET /api/v1/ui/groups/:id/day — per-user rate limit (HTTP)', () => {
    it('429s the request that exceeds the per-user limit and sets Retry-After', async () => {
      const userId = `user_rl_groupday_${Date.now()}`

      let callCount = 0
      const stubbedRateLimit = {
        async takeToken() {
          callCount++
          if (callCount >= 2) {
            return { allowed: false, retryAfterSeconds: 50, blendedCount: 61 }
          }
          return { allowed: true, retryAfterSeconds: 0, blendedCount: callCount }
        },
        async reset() {},
        async pruneOldBuckets() { return 0 },
      }

      // Use real sessions (D1) but stub rateLimit; use sessionServices so
      // verifyRpidBearer returns the seeded userId correctly.
      const hybridRepos: Repos = { ...repos, rateLimit: stubbedRateLimit }
      const hybridApp = buildApp({ env: envVars, logger: undefined, repos: hybridRepos, services: sessionServices })

      const bearer = await loginAs(userId, hybridRepos)
      const hdrs = sessionHeaders(bearer)

      // First: create an event and group to have a valid group id.
      const evtRes = await hybridApp.request('http://localhost/api/v1/ui/events', {
        method: 'POST',
        headers: { ...hdrs, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'RL Event', timezone: 'UTC' }),
      })
      expect(evtRes.status).toBe(201)
      const { id: eventId } = (await evtRes.json()) as { id: string }

      const grpRes = await hybridApp.request(`http://localhost/api/v1/ui/events/${eventId}/groups`, {
        method: 'POST',
        headers: { ...hdrs, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'RL Group' }),
      })
      expect(grpRes.status).toBe(201)
      const { id: groupId } = (await grpRes.json()) as { id: string }

      // Reset callCount after fixture setup so the rate-limit stub counts
      // only group-day requests.
      callCount = 0

      // First group-day request: within limit.
      const res1 = await hybridApp.request(
        `http://localhost/api/v1/ui/groups/${groupId}/day?date=2026-06-10`,
        { headers: hdrs },
      )
      expect(res1.status).toBe(200)

      // Second group-day request: limit exceeded.
      const res2 = await hybridApp.request(
        `http://localhost/api/v1/ui/groups/${groupId}/day?date=2026-06-10`,
        { headers: hdrs },
      )
      expect(res2.status).toBe(429)
      expect(res2.headers.get('Retry-After')).toBe('50')
      const body = (await res2.json()) as { error?: { code?: string; details?: { retry_after_seconds?: number } } }
      expect(body.error?.code).toBe('rate_limited')
      expect(body.error?.details?.retry_after_seconds).toBe(50)
    })

    it('does not rate-limit a different user when one user is exhausted (bucket isolation)', async () => {
      const user1 = `user_rl_gd_u1_${Date.now()}`
      const user2 = `user_rl_gd_u2_${Date.now()}`

      // Track per-bucket call counts to isolate users.
      const callCounts: Record<string, number> = {}
      const stubbedRateLimit = {
        async takeToken(input: { tenantId: string; bucketKey: string; limit: number; windowSeconds: number }) {
          const key = input.bucketKey
          callCounts[key] = (callCounts[key] ?? 0) + 1
          if (callCounts[key] >= 2) {
            return { allowed: false, retryAfterSeconds: 50, blendedCount: 61 }
          }
          return { allowed: true, retryAfterSeconds: 0, blendedCount: callCounts[key] }
        },
        async reset() {},
        async pruneOldBuckets() { return 0 },
      }

      const hybridRepos: Repos = { ...repos, rateLimit: stubbedRateLimit as unknown as Repos['rateLimit'] }
      const hybridApp = buildApp({ env: envVars, logger: undefined, repos: hybridRepos, services: sessionServices })

      const bearer1 = await loginAs(user1, hybridRepos)
      const bearer2 = await loginAs(user2, hybridRepos)

      // Create a group owned by user1 and join user2.
      const evtRes = await hybridApp.request('http://localhost/api/v1/ui/events', {
        method: 'POST',
        headers: { ...sessionHeaders(bearer1), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'RL Isolation Event', timezone: 'UTC' }),
      })
      expect(evtRes.status).toBe(201)
      const { id: eventId } = (await evtRes.json()) as { id: string }

      const grpRes = await hybridApp.request(`http://localhost/api/v1/ui/events/${eventId}/groups`, {
        method: 'POST',
        headers: { ...sessionHeaders(bearer1), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'RL Isolation Group' }),
      })
      expect(grpRes.status).toBe(201)
      const { id: groupId } = (await grpRes.json()) as { id: string }

      // Add user2 as a member so they can access the group.
      await hybridRepos.groupMembers.add({ id: `gm_${ulid()}`, groupId, userId: user2, role: 'member' })

      // Reset counts so only group-day calls are tracked.
      for (const k of Object.keys(callCounts)) delete callCounts[k]

      // Exhaust user1's bucket (2 calls → denied on 2nd).
      await hybridApp.request(`http://localhost/api/v1/ui/groups/${groupId}/day?date=2026-06-10`, {
        headers: sessionHeaders(bearer1),
      })
      const blocked = await hybridApp.request(`http://localhost/api/v1/ui/groups/${groupId}/day?date=2026-06-10`, {
        headers: sessionHeaders(bearer1),
      })
      expect(blocked.status).toBe(429)

      // user2 should still be allowed (fresh bucket).
      const fresh = await hybridApp.request(`http://localhost/api/v1/ui/groups/${groupId}/day?date=2026-06-10`, {
        headers: sessionHeaders(bearer2),
      })
      expect(fresh.status).toBe(200)
    })
  })

  // ---- rateLimit repo — per-user bucket isolation (D1 repo directly) -

  describe('rateLimit repo — per-user bucket isolation', () => {
    it('allows up to the configured limit and blocks on excess', async () => {
      const tenantId = 'rallypoint'
      const user1Bucket = 'user:user_rl_bucket_1:group-day'
      const user2Bucket = 'user:user_rl_bucket_2:group-day'
      const limit = 3
      const windowSeconds = 60

      // user1: send exactly 3 requests (should all be allowed).
      for (let i = 0; i < limit; i++) {
        const d = await repos.rateLimit.takeToken({
          tenantId,
          bucketKey: user1Bucket,
          limit,
          windowSeconds,
        })
        expect(d.allowed).toBe(true)
      }

      // user1: 4th request should be denied.
      const d4 = await repos.rateLimit.takeToken({
        tenantId,
        bucketKey: user1Bucket,
        limit,
        windowSeconds,
      })
      expect(d4.allowed).toBe(false)
      expect(d4.retryAfterSeconds).toBeGreaterThan(0)

      // user2: unaffected — still allowed.
      const d2 = await repos.rateLimit.takeToken({
        tenantId,
        bucketKey: user2Bucket,
        limit,
        windowSeconds,
      })
      expect(d2.allowed).toBe(true)
    })
  })
})
