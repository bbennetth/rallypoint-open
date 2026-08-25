import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import type { FoodSubmissionAdminDto } from '@rallypoint/fitness-shared'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import { encryptBearer } from '../crypto/encryption.js'
import { ADMIN_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'

// D1 integration tests for the requireSession + requireAdmin gate and the
// food-submission review-queue proxy routes. Mirrors review.d1.test.ts.

const CSRF = 'csrf_token_value_admin_food_review_aaaaaaaaaaaa'

const DTO: FoodSubmissionAdminDto = {
  id: 'food_sub_1',
  status: 'pending',
  createdAt: '2026-07-01T10:00:00.000Z',
  submitterUserId: 'user_submitter',
  upc: '012345678905',
  item: {
    name: 'Protein Bar',
    brand: 'Acme',
    servingGrams: 60,
    servingQuantity: 1,
    servingUnit: 'g',
    isLiquid: false,
    per100g: { kcal: 380, protein: 30, carbs: 40, fat: 12 },
  },
  adminNote: null,
  globalFoodItemId: null,
  migrationStatus: 'none',
  aiScan: null,
}

const SCAN_DTO = {
  id: 'fscan_food_1',
  status: 'done' as const,
  verdict: 'ok' as const,
  findings: [],
  model: 'test-model',
  createdAt: '2026-07-01T10:00:00.000Z',
  completedAt: '2026-07-01T10:00:05.000Z',
}

interface Call {
  method: string
  args: unknown[]
}

function makeServices(calls: Call[]): Services {
  return {
    idClient: {
      // The sealed plaintext IS the userId in these tests.
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: {
      exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
    },
    profiles: { lookup: async () => null },
    settings: {
      get: async () => ({}),
      patch: async (_u, _n, patch) => patch,
    },
    fitness: {
      listSubmissions: async () => [],
      getSubmission: async () => null,
      approveSubmission: async () => null,
      rejectSubmission: async () => null,
      rescanSubmission: async () => ({ outcome: 'not_found' as const }),
    },
    foodSubmissions: {
      listFoodSubmissions: async (status) => {
        calls.push({ method: 'listFoodSubmissions', args: [status] })
        return [DTO]
      },
      getFoodSubmission: async (id) => {
        calls.push({ method: 'getFoodSubmission', args: [id] })
        return id === DTO.id ? DTO : null
      },
      approveFoodSubmission: async (id, opts) => {
        calls.push({ method: 'approveFoodSubmission', args: [id, opts] })
        if (id === 'food_sub_reviewed') return 'not_pending'
        return { ...DTO, status: 'approved', adminNote: opts?.note ?? null }
      },
      rejectFoodSubmission: async (id, opts) => {
        calls.push({ method: 'rejectFoodSubmission', args: [id, opts] })
        return { ...DTO, status: 'rejected', adminNote: opts?.note ?? null }
      },
      rescanFoodSubmission: async (id, opts) => {
        calls.push({ method: 'rescanFoodSubmission', args: [id, opts] })
        if (id === 'food_sub_nope') return { outcome: 'not_found' as const }
        if (id === 'food_sub_scanning') return { outcome: 'already_pending' as const }
        return { outcome: 'scanned' as const, scan: SCAN_DTO }
      },
    },
    systemEvents: {
      list: async () => ({ kind: 'ok' as const, data: { items: [], nextCursor: null } }),
      get: async () => ({ kind: 'not_found' as const }),
      create: async () => ({ kind: 'forbidden' as const }),
      patch: async () => ({ kind: 'not_found' as const }),
      softDelete: async () => ({ kind: 'not_found' as const }),
      restore: async () => ({ kind: 'not_found' as const }),
    },
    exerciseCatalog: {
      listExercises: async () => [],
      getExercise: async () => null,
      updateExercise: async () => null,
      aiReviewExercise: async () => ({ outcome: 'not_found' as const }),
      aiReviewBatch: async () => 'ai_unavailable' as const,
      listAiReviews: async () => [],
      applyAiReview: async () => null,
      dismissAiReview: async () => null,
    },
  }
}

describe('admin food-review routes — session + allowlist gate + FITNESS proxy', () => {
  let repos: Repos
  let envVars: Env
  let calls: Call[]
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      ADMIN_USER_IDS: 'user_admin, user_other_admin',
    })
    calls = []
    app = buildApp({ env: envVars, repos, services: makeServices(calls) })
  })

  // Mint a real admin-api session row for `userId` and return the cookie value.
  async function mintSession(userId: string): Promise<string> {
    const bearer = generateRawToken(ADMIN_SESSION_BEARER_PREFIX)
    const idHash = hashToken(bearer)
    const sealed = encryptBearer({
      plaintext: userId, // the stub idClient echoes this back as the userId
      aad: idHash,
      env: envVars,
      keyVersion: envVars.ADMIN_SESSION_KEY_VERSION,
    })
    await repos.sessions.create({
      idHash,
      userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ipHash: 'ip_hash_test',
      uaHash: 'ua_hash_test',
    })
    return bearer
  }

  function headers(cookieValue?: string): Record<string, string> {
    const cookies = [
      ...(cookieValue ? [`${envVars.ADMIN_SESSION_COOKIE_NAME}=${cookieValue}`] : []),
      `${envVars.ADMIN_CSRF_COOKIE_NAME}=${CSRF}`,
    ].join('; ')
    return {
      cookie: cookies,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
      origin: envVars.ADMIN_UI_ORIGIN,
    }
  }

  it('401 with no session cookie', async () => {
    const res = await app.request('http://localhost/api/v1/ui/food-submissions', {
      headers: headers(),
    })
    expect(res.status).toBe(401)
  })

  it('403 for a signed-in user NOT on the allowlist', async () => {
    const bearer = await mintSession('user_regular')
    const res = await app.request('http://localhost/api/v1/ui/food-submissions', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('forbidden')
  })

  it('200 list (default pending) for an allowlisted admin, proxied to FITNESS', async () => {
    const bearer = await mintSession('user_admin')
    const res = await app.request('http://localhost/api/v1/ui/food-submissions', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: FoodSubmissionAdminDto[] }
    expect(body.items).toEqual([DTO])
    expect(calls.at(-1)).toEqual({ method: 'listFoodSubmissions', args: ['pending'] })
  })

  it('passes an explicit ?status= filter through and rejects a bogus one', async () => {
    const bearer = await mintSession('user_admin')
    const ok = await app.request('http://localhost/api/v1/ui/food-submissions?status=rejected', {
      headers: headers(bearer),
    })
    expect(ok.status).toBe(200)
    expect(calls.at(-1)).toEqual({ method: 'listFoodSubmissions', args: ['rejected'] })

    const bad = await app.request('http://localhost/api/v1/ui/food-submissions?status=bogus', {
      headers: headers(bearer),
    })
    expect(bad.status).toBe(400)
  })

  it('GET /:id returns the DTO and 404s an unknown id', async () => {
    const bearer = await mintSession('user_admin')
    const ok = await app.request('http://localhost/api/v1/ui/food-submissions/food_sub_1', {
      headers: headers(bearer),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual(DTO)

    const missing = await app.request(
      'http://localhost/api/v1/ui/food-submissions/food_sub_nope',
      { headers: headers(bearer) },
    )
    expect(missing.status).toBe(404)
  })

  it('POST /:id/approve forwards the optional note', async () => {
    const bearer = await mintSession('user_admin')
    const res = await app.request(
      'http://localhost/api/v1/ui/food-submissions/food_sub_1/approve',
      {
        method: 'POST',
        headers: headers(bearer),
        body: JSON.stringify({ note: 'looks good' }),
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as FoodSubmissionAdminDto
    expect(body.status).toBe('approved')
    expect(calls.at(-1)).toEqual({
      method: 'approveFoodSubmission',
      args: ['food_sub_1', { note: 'looks good' }],
    })
  })

  it('POST /:id/reject works with an empty body (no note)', async () => {
    const bearer = await mintSession('user_admin')
    const res = await app.request(
      'http://localhost/api/v1/ui/food-submissions/food_sub_1/reject',
      { method: 'POST', headers: headers(bearer) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as FoodSubmissionAdminDto
    expect(body.status).toBe('rejected')
    expect(calls.at(-1)).toEqual({
      method: 'rejectFoodSubmission',
      args: ['food_sub_1', {}],
    })
  })

  it('POST /:id/approve maps not_pending to a 409 conflict', async () => {
    const bearer = await mintSession('user_admin')
    const res = await app.request(
      'http://localhost/api/v1/ui/food-submissions/food_sub_reviewed/approve',
      { method: 'POST', headers: headers(bearer) },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('submission_not_pending')
  })

  it('POST /:id/rescan returns the scan, threads the actor, and maps the guard outcomes', async () => {
    const bearer = await mintSession('user_admin')
    const ok = await app.request('http://localhost/api/v1/ui/food-submissions/food_sub_1/rescan', {
      method: 'POST',
      headers: headers(bearer),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ outcome: 'scanned', scan: SCAN_DTO })
    expect(calls.at(-1)).toEqual({
      method: 'rescanFoodSubmission',
      args: ['food_sub_1', { actorUserId: 'user_admin' }],
    })

    const missing = await app.request(
      'http://localhost/api/v1/ui/food-submissions/food_sub_nope/rescan',
      { method: 'POST', headers: headers(bearer) },
    )
    expect(missing.status).toBe(404)

    const pending = await app.request(
      'http://localhost/api/v1/ui/food-submissions/food_sub_scanning/rescan',
      { method: 'POST', headers: headers(bearer) },
    )
    expect(pending.status).toBe(409)
    expect(((await pending.json()) as { error: { code: string } }).error.code).toBe('scan_pending')
  })

  it('rejects a state-changing request without the CSRF header', async () => {
    const bearer = await mintSession('user_admin')
    const res = await app.request(
      'http://localhost/api/v1/ui/food-submissions/food_sub_1/approve',
      {
        method: 'POST',
        headers: {
          cookie: `${envVars.ADMIN_SESSION_COOKIE_NAME}=${bearer}; ${envVars.ADMIN_CSRF_COOKIE_NAME}=${CSRF}`,
          origin: envVars.ADMIN_UI_ORIGIN,
        },
      },
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('csrf_token_invalid')
  })
})
