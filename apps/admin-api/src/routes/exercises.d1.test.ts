import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import type { ExerciseAiReviewDto, ExerciseDto } from '@rallypoint/fitness-shared'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import { encryptBearer } from '../crypto/encryption.js'
import { ADMIN_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import { aiReviewCursorCodec } from '../lib/ai-review-cursor.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'

// D1 integration tests for the admin exercise-catalog + AI-review proxy
// routes: real session rows in Miniflare D1, a stubbed FITNESS binding
// (same conventions as review.d1.test.ts).

const CSRF = 'csrf_token_value_admin_catalog_aaaaaaaaaaa'

const EXERCISE: ExerciseDto = {
  id: 'fx_seed_back_squat',
  name: 'Back Squat',
  isCustom: false,
  discipline: 'barbell',
  movementPattern: 'squat',
  metricShape: 'load_reps',
  unilateral: false,
  muscles: [
    { muscleId: 'quads', role: 'primary' },
    { muscleId: 'glutes', role: 'primary' },
  ],
}

const REVIEW: ExerciseAiReviewDto = {
  id: 'fair_1',
  exerciseId: EXERCISE.id,
  exerciseName: EXERCISE.name,
  currentMuscles: EXERCISE.muscles,
  proposedMuscles: [
    { muscleId: 'quads', role: 'primary' },
    { muscleId: 'glutes', role: 'primary' },
    { muscleId: 'erectors', role: 'stabilizer' },
  ],
  rationale: 'Squats brace through the erectors.',
  model: '@cf/mistralai/mistral-small-3.1-24b-instruct',
  status: 'pending',
  createdAt: '2026-07-20T10:00:00.000Z',
  reviewedAt: null,
}

interface Call {
  method: string
  args: unknown[]
}

function makeServices(calls: Call[]): Services {
  return {
    idClient: {
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
    },
    foodSubmissions: {
      listFoodSubmissions: async () => [],
      getFoodSubmission: async () => null,
      approveFoodSubmission: async () => null,
      rejectFoodSubmission: async () => null,
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
      listExercises: async (filter) => {
        calls.push({ method: 'listExercises', args: [filter] })
        return [EXERCISE]
      },
      getExercise: async (id) => {
        calls.push({ method: 'getExercise', args: [id] })
        return id === EXERCISE.id ? EXERCISE : null
      },
      updateExercise: async (id, input) => {
        calls.push({ method: 'updateExercise', args: [id, input] })
        if (id === 'fx_invalid') return 'invalid'
        if (id === 'fx_taken') return 'name_taken'
        if (id !== EXERCISE.id) return null
        return { ...EXERCISE, unilateral: true }
      },
      aiReviewExercise: async (id, opts) => {
        calls.push({ method: 'aiReviewExercise', args: [id, opts] })
        if (id !== EXERCISE.id) return { outcome: 'not_found' as const }
        return { outcome: 'proposed' as const, review: REVIEW }
      },
      aiReviewBatch: async (input) => {
        calls.push({ method: 'aiReviewBatch', args: [input] })
        return { processed: 5, proposed: 2, unchanged: 3, skipped: 0, nextCursor: 'fx_x' }
      },
      listAiReviews: async (status) => {
        calls.push({ method: 'listAiReviews', args: [status] })
        return [REVIEW]
      },
      applyAiReview: async (id) => {
        calls.push({ method: 'applyAiReview', args: [id] })
        if (id === 'fair_done') return 'not_pending'
        return id === REVIEW.id ? { ...REVIEW, status: 'applied' as const } : null
      },
      dismissAiReview: async (id) => {
        calls.push({ method: 'dismissAiReview', args: [id] })
        return id === REVIEW.id ? { ...REVIEW, status: 'dismissed' as const } : null
      },
      bulkDecideAiReviews: async (ids, action) => {
        calls.push({ method: 'bulkDecideAiReviews', args: [ids, action] })
        return {
          applied: action === 'apply' ? ids.length : 0,
          dismissed: action === 'dismiss' ? ids.length : 0,
          failed: 0,
          items: ids.map((id) => ({
            id,
            outcome: action === 'apply' ? ('applied' as const) : ('dismissed' as const),
          })),
        }
      },
    },
  }
}

describe('admin exercise-catalog routes — gate + FITNESS proxy', () => {
  let repos: Repos
  let envVars: Env
  let calls: Call[]
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      ADMIN_USER_IDS: 'user_admin',
    })
    calls = []
    app = buildApp({ env: envVars, repos, services: makeServices(calls) })
  })

  async function mintSession(userId: string): Promise<string> {
    const bearer = generateRawToken(ADMIN_SESSION_BEARER_PREFIX)
    const idHash = hashToken(bearer)
    const sealed = encryptBearer({
      plaintext: userId,
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

  it('401 without a session, 403 for a non-admin', async () => {
    const anon = await app.request('http://localhost/api/v1/ui/exercises', {
      headers: headers(),
    })
    expect(anon.status).toBe(401)

    const bearer = await mintSession('user_regular')
    const nonAdmin = await app.request('http://localhost/api/v1/ui/exercises', {
      headers: headers(bearer),
    })
    expect(nonAdmin.status).toBe(403)

    const aiAnon = await app.request('http://localhost/api/v1/ui/ai-reviews', {
      headers: headers(),
    })
    expect(aiAnon.status).toBe(401)
  })

  it('GET /exercises proxies filters; 400s an unknown group/muscle', async () => {
    const bearer = await mintSession('user_admin')
    const ok = await app.request(
      'http://localhost/api/v1/ui/exercises?q=squat&group=leg&muscle=quads',
      { headers: headers(bearer) },
    )
    expect(ok.status).toBe(200)
    expect((await ok.json()) as unknown).toEqual({ items: [EXERCISE] })
    expect(calls.at(-1)).toEqual({
      method: 'listExercises',
      args: [{ q: 'squat', group: 'leg', muscle: 'quads' }],
    })

    const badGroup = await app.request('http://localhost/api/v1/ui/exercises?group=nope', {
      headers: headers(bearer),
    })
    expect(badGroup.status).toBe(400)
    const badMuscle = await app.request(
      'http://localhost/api/v1/ui/exercises?muscle=rear_delt',
      { headers: headers(bearer) },
    )
    expect(badMuscle.status).toBe(400)
  })

  it('PATCH /exercises/:id maps markers to 404/400/409', async () => {
    const bearer = await mintSession('user_admin')
    const patch = { unilateral: true }
    const ok = await app.request(`http://localhost/api/v1/ui/exercises/${EXERCISE.id}`, {
      method: 'PATCH',
      headers: headers(bearer),
      body: JSON.stringify(patch),
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as ExerciseDto).unilateral).toBe(true)

    const missing = await app.request('http://localhost/api/v1/ui/exercises/fx_nope', {
      method: 'PATCH',
      headers: headers(bearer),
      body: JSON.stringify(patch),
    })
    expect(missing.status).toBe(404)

    const invalid = await app.request('http://localhost/api/v1/ui/exercises/fx_invalid', {
      method: 'PATCH',
      headers: headers(bearer),
      body: JSON.stringify(patch),
    })
    expect(invalid.status).toBe(400)

    const taken = await app.request('http://localhost/api/v1/ui/exercises/fx_taken', {
      method: 'PATCH',
      headers: headers(bearer),
      body: JSON.stringify(patch),
    })
    expect(taken.status).toBe(409)
  })

  it('AI review routes proxy through: single, batch, list, apply, dismiss', async () => {
    const bearer = await mintSession('user_admin')

    const single = await app.request(
      `http://localhost/api/v1/ui/exercises/${EXERCISE.id}/ai-review`,
      { method: 'POST', headers: headers(bearer), body: '{}' },
    )
    expect(single.status).toBe(200)
    expect(((await single.json()) as { outcome: string }).outcome).toBe('proposed')
    // The acting admin's id rides along — it attributes the ai_traces row.
    expect(calls.at(-1)).toEqual({
      method: 'aiReviewExercise',
      args: [EXERCISE.id, { actorUserId: 'user_admin' }],
    })

    const batch = await app.request('http://localhost/api/v1/ui/ai-reviews/batch', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ cursor: null, limit: 5 }),
    })
    expect(batch.status).toBe(200)
    const batchBody = (await batch.json()) as { next_cursor: string; nextCursor: string }
    // The RPC's raw next id ('fx_x') is re-encoded opaquely at the edge and
    // dual-emitted as next_cursor + nextCursor for the transition.
    expect(batchBody.next_cursor).not.toBe('fx_x')
    expect(batchBody.next_cursor).toBe(batchBody.nextCursor)
    expect(aiReviewCursorCodec.decode(batchBody.next_cursor)).toEqual({ id: 'fx_x' })
    // The RPC still receives a raw id cursor (null on the first page).
    expect(calls.at(-1)).toEqual({
      method: 'aiReviewBatch',
      args: [{ cursor: null, limit: 5, actorUserId: 'user_admin' }],
    })

    // A follow-up page: the opaque cursor decodes back to the raw id over RPC.
    const batch2 = await app.request('http://localhost/api/v1/ui/ai-reviews/batch', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ cursor: batchBody.next_cursor, limit: 5 }),
    })
    expect(batch2.status).toBe(200)
    expect(calls.at(-1)).toEqual({
      method: 'aiReviewBatch',
      args: [{ cursor: 'fx_x', limit: 5, actorUserId: 'user_admin' }],
    })

    // A legacy bare-id cursor (stale bundle) still decodes to the raw id.
    const batchLegacy = await app.request('http://localhost/api/v1/ui/ai-reviews/batch', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ cursor: 'fx_legacy', limit: 5 }),
    })
    expect(batchLegacy.status).toBe(200)
    expect(calls.at(-1)).toEqual({
      method: 'aiReviewBatch',
      args: [{ cursor: 'fx_legacy', limit: 5, actorUserId: 'user_admin' }],
    })

    const list = await app.request('http://localhost/api/v1/ui/ai-reviews', {
      headers: headers(bearer),
    })
    expect(list.status).toBe(200)
    expect(calls.at(-1)).toEqual({ method: 'listAiReviews', args: ['pending'] })

    const apply = await app.request(`http://localhost/api/v1/ui/ai-reviews/${REVIEW.id}/apply`, {
      method: 'POST',
      headers: headers(bearer),
      body: '{}',
    })
    expect(apply.status).toBe(200)

    const conflict = await app.request('http://localhost/api/v1/ui/ai-reviews/fair_done/apply', {
      method: 'POST',
      headers: headers(bearer),
      body: '{}',
    })
    expect(conflict.status).toBe(409)

    const dismiss = await app.request(
      `http://localhost/api/v1/ui/ai-reviews/${REVIEW.id}/dismiss`,
      { method: 'POST', headers: headers(bearer), body: '{}' },
    )
    expect(dismiss.status).toBe(200)
  })

  it('POST /ai-reviews/bulk proxies ids+action; 400s an empty or oversized batch', async () => {
    const bearer = await mintSession('user_admin')

    const ok = await app.request('http://localhost/api/v1/ui/ai-reviews/bulk', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ ids: ['fair_1', 'fair_2'], action: 'dismiss' }),
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()) as unknown).toEqual({
      applied: 0,
      dismissed: 2,
      failed: 0,
      items: [
        { id: 'fair_1', outcome: 'dismissed' },
        { id: 'fair_2', outcome: 'dismissed' },
      ],
    })
    expect(calls.at(-1)).toEqual({
      method: 'bulkDecideAiReviews',
      args: [['fair_1', 'fair_2'], 'dismiss'],
    })

    const empty = await app.request('http://localhost/api/v1/ui/ai-reviews/bulk', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ ids: [], action: 'apply' }),
    })
    expect(empty.status).toBe(400)

    const oversized = await app.request('http://localhost/api/v1/ui/ai-reviews/bulk', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({
        ids: Array.from({ length: 201 }, (_, i) => `fair_${i}`),
        action: 'apply',
      }),
    })
    expect(oversized.status).toBe(400)

    const badAction = await app.request('http://localhost/api/v1/ui/ai-reviews/bulk', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ ids: ['fair_1'], action: 'approve' }),
    })
    expect(badAction.status).toBe(400)
  })
})
