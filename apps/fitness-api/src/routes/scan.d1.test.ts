import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the WOD whiteboard-photo scan route. Real D1
// via vitest-pool-workers; the Workers AI vision service is stubbed so we
// can drive its failure modes. Covers the error-mapping the reliability
// fix added: a transient Workers AI capacity error → retryable 503
// `ai_capacity`, any other vision failure → enveloped 502 `scan_failed`.

const CSRF = 'csrf_token_value_scan_aaaaaaaaaaaaaaaaaa'
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const parseWodFromImage = vi.fn()

const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
  },
  rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
  profiles: { lookup: async () => null },
  settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
  offClient: { lookup: async () => null, search: async () => [] },
  vision: { parseWodFromImage },
  aiTraces: { recordTrace: async () => {}, recordFeedback: async () => ({ ok: true }) },
} as unknown as Services

describe('D1 integration — WOD scan route', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let db: Db

  beforeAll(async () => {
    db = createDb(env.DB)
    repos = buildD1Repos(db)
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(FITNESS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { FITNESS_SESSION_KEY_V1: envVars.FITNESS_SESSION_KEY_V1 },
      keyVersion: envVars.FITNESS_SESSION_KEY_VERSION,
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

  function req(bearer: string, body: unknown): Promise<Response> {
    return app.request('http://localhost/api/v1/ui/scan/wod', {
      method: 'POST',
      headers: {
        cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
        'content-type': 'application/json',
        origin: envVars.FITNESS_UI_ORIGIN,
      },
      body: JSON.stringify(body),
    })
  }

  it('returns the parsed WOD on a successful vision read', async () => {
    const bearer = await loginAs('user_wod_ok')
    // Carries `rounds` + a per-type field so the route is pinned as a pure
    // passthrough of the widened scan DTO — a round count that survives the
    // vision service must survive the response too.
    const parsed = {
      type: 'rounds_for_time',
      rounds: 10,
      restS: 60,
      movements: [{ name: 'Burpees', reps: 10 }],
    }
    parseWodFromImage.mockResolvedValueOnce(parsed)
    const res = await req(bearer, { imageBase64: TINY_PNG_B64, mimeType: 'image/png' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ parsed, responseId: null })
  })

  it('maps a non-capacity vision failure to an enveloped 502 scan_failed', async () => {
    const bearer = await loginAs('user_wod_err')
    parseWodFromImage.mockRejectedValueOnce(new Error('returned no JSON object'))
    const res = await req(bearer, { imageBase64: TINY_PNG_B64, mimeType: 'image/png' })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('scan_failed')
    expect(body.error.message).toContain('workout')
  })

  it('maps a Workers AI capacity error to a retryable 503 ai_capacity', async () => {
    const bearer = await loginAs('user_wod_cap')
    parseWodFromImage.mockRejectedValueOnce(
      Object.assign(new Error('3040: Capacity temporarily exceeded, please try again'), {
        name: 'AiError',
      }),
    )
    const res = await req(bearer, { imageBase64: TINY_PNG_B64, mimeType: 'image/png' })
    expect(res.status).toBe(503)
    const body = (await res.json()) as {
      error: { code: string; details?: { retry_after_seconds?: number } }
    }
    expect(body.error.code).toBe('ai_capacity')
    expect(body.error.details?.retry_after_seconds).toBeGreaterThan(0)
  })

  // --- per-user rate limiting -----------------------------------------
  // The WOD scan shares the fitness `ai-scan` bucket with the three food
  // vision endpoints. Stub repos.rateLimit (rather than loop 10 real
  // requests) so we can assert the exact bucket key + the deny path, and
  // prove the model is never touched once the bucket is exhausted.
  function reqTo(hybridApp: Hono<HonoApp>, bearer: string, body: unknown): Promise<Response> {
    return hybridApp.request('http://localhost/api/v1/ui/scan/wod', {
      method: 'POST',
      headers: {
        cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
        'content-type': 'application/json',
        origin: envVars.FITNESS_UI_ORIGIN,
      },
      body: JSON.stringify(body),
    })
  }

  it('429s + Retry-After on the ai-scan bucket without calling the vision model', async () => {
    const bearer = await loginAs('user_wod_rl')
    const seen: string[] = []
    const stubbedRateLimit = {
      async takeToken(input: { bucketKey: string }) {
        seen.push(input.bucketKey)
        return { allowed: false, retryAfterSeconds: 42, blendedCount: 11 }
      },
      async reset() {},
      async pruneOldBuckets() {
        return 0
      },
    }
    const hybridApp = buildApp({
      env: envVars,
      logger: undefined,
      repos: { ...repos, rateLimit: stubbedRateLimit } as unknown as Repos,
      services,
    })
    parseWodFromImage.mockClear()
    const res = await reqTo(hybridApp, bearer, { imageBase64: TINY_PNG_B64, mimeType: 'image/png' })
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('42')
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('rate_limited')
    // Shared bucket with the food vision endpoints (see food.d1.test.ts).
    expect(seen).toEqual(['user:user_wod_rl:ai-scan'])
    expect(parseWodFromImage).not.toHaveBeenCalled()
  })

  it('rate-limit bucket is per-user (a different user is unaffected)', async () => {
    // Deny only the first user's bucket; a second user passes through.
    const stubbedRateLimit = {
      async takeToken(input: { bucketKey: string }) {
        if (input.bucketKey === 'user:user_wod_rl_a:ai-scan') {
          return { allowed: false, retryAfterSeconds: 30, blendedCount: 11 }
        }
        return { allowed: true, retryAfterSeconds: 0, blendedCount: 1 }
      },
      async reset() {},
      async pruneOldBuckets() {
        return 0
      },
    }
    const hybridApp = buildApp({
      env: envVars,
      logger: undefined,
      repos: { ...repos, rateLimit: stubbedRateLimit } as unknown as Repos,
      services,
    })
    const blocked = await loginAs('user_wod_rl_a')
    expect(
      (await reqTo(hybridApp, blocked, { imageBase64: TINY_PNG_B64, mimeType: 'image/png' })).status,
    ).toBe(429)

    const ok = await loginAs('user_wod_rl_b')
    parseWodFromImage.mockResolvedValueOnce({ type: 'for_time', movements: [] })
    const res = await reqTo(hybridApp, ok, { imageBase64: TINY_PNG_B64, mimeType: 'image/png' })
    expect(res.status).toBe(200)
  })
})
