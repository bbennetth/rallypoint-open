import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { exercises } from '@rallypoint/fitness-db'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import type { WorkoutDto } from '@rallypoint/fitness-shared'

// D1 integration tests for the workout logging UI surface. Runs inside a
// workerd isolate (Miniflare D1); migrations are applied by
// test/apply-d1-migrations.ts. The seeded global exercise catalog supplies
// real exercise IDs to reference in sets.

const CSRF = 'csrf_token_value_workouts_aaaaaaaaaaaaaaaa'

const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
  },
  rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
  profiles: { lookup: async () => null },
  settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
  offClient: { lookup: async () => null },
}

describe('D1 integration — workout logging UI surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let db: Db
  // A known exercise id we'll insert to ensure catalog visibility.
  let knownExerciseId: string

  beforeAll(async () => {
    db = createDb(env.DB)
    repos = buildD1Repos(db)
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })

    // Seed a deterministic global exercise for set references.
    knownExerciseId = 'fx_wt_test_global_ex'
    await db.insert(exercises).values({
      id: knownExerciseId,
      name: 'WT Test Squat',
      ownerUserId: null,
      discipline: 'barbell',
      movementPattern: 'squat',
      metricShape: 'load_reps',
      unilateral: false,
    })
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

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
      origin: envVars.FITNESS_UI_ORIGIN,
    }
  }

  async function req(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('rejects workout list without a session (401)', async () => {
    const res = await app.request('http://localhost/api/v1/ui/workouts', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('creates a workout with sets (201) — sets persist with correct exercise ref', async () => {
    const bearer = await loginAs('user_wt_create')
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-01T09:00:00.000Z',
      modality: 'strength',
      title: 'Morning Squats',
      durationS: 3600,
      rpe: 7,
      sets: [
        { exerciseId: knownExerciseId, setIndex: 0, reps: 5, loadKg: 100 },
        { exerciseId: knownExerciseId, setIndex: 1, reps: 5, loadKg: 105 },
        { exerciseId: knownExerciseId, setIndex: 2, reps: 3, loadKg: 110 },
      ],
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as WorkoutDto
    expect(dto.id).toMatch(/^fs_/)
    expect(dto.modality).toBe('strength')
    expect(dto.title).toBe('Morning Squats')
    expect(dto.durationS).toBe(3600)
    expect(dto.rpe).toBe(7)
    expect(dto.sets).toHaveLength(3)
    expect(dto.sets[0].id).toMatch(/^fset_/)
    expect(dto.sets[0].exerciseId).toBe(knownExerciseId)
    expect(dto.sets[0].reps).toBe(5)
    expect(dto.sets[0].loadKg).toBe(100)
    expect(dto.sets[2].loadKg).toBe(110)
    // Verify persisted via GET.
    const got = await req(bearer, 'GET', `/api/v1/ui/workouts/${dto.id}`)
    expect(got.status).toBe(200)
    const fetched = (await got.json()) as WorkoutDto
    expect(fetched.sets).toHaveLength(3)
    expect(fetched.sets.map((s) => s.setIndex)).toEqual([0, 1, 2])
  })

  it('setType round-trips when supplied, and defaults to working when omitted', async () => {
    const bearer = await loginAs('user_wt_settype')
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-01T09:00:00.000Z',
      modality: 'strength',
      sets: [
        { exerciseId: knownExerciseId, setIndex: 0, reps: 5, loadKg: 60, setType: 'warmup' },
        { exerciseId: knownExerciseId, setIndex: 1, reps: 5, loadKg: 100 },
      ],
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as WorkoutDto
    expect(dto.sets[0].setType).toBe('warmup')
    expect(dto.sets[1].setType).toBe('working')
    // Verify persisted via GET.
    const got = await req(bearer, 'GET', `/api/v1/ui/workouts/${dto.id}`)
    const fetched = (await got.json()) as WorkoutDto
    expect(fetched.sets[0].setType).toBe('warmup')
    expect(fetched.sets[1].setType).toBe('working')
  })

  it('creates a workout without sets (201)', async () => {
    const bearer = await loginAs('user_wt_nosers')
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-02T08:00:00.000Z',
      modality: 'endurance',
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as WorkoutDto
    expect(dto.sets).toHaveLength(0)
    expect(dto.modality).toBe('endurance')
  })

  it('lists workouts newest-first with a date-range filter', async () => {
    const bearer = await loginAs('user_wt_list')

    // Insert three workouts at different dates.
    await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-05-01T07:00:00.000Z',
      modality: 'strength',
      sets: [{ exerciseId: knownExerciseId, reps: 3, loadKg: 90 }],
    })
    await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-05-15T07:00:00.000Z',
      modality: 'conditioning',
    })
    await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-10T07:00:00.000Z',
      modality: 'mobility',
    })

    // No filter — should return all three, newest first.
    const allRes = await req(bearer, 'GET', '/api/v1/ui/workouts')
    expect(allRes.status).toBe(200)
    const allBody = (await allRes.json()) as { workouts: WorkoutDto[] }
    expect(allBody.workouts).toHaveLength(3)
    const dates = allBody.workouts.map((w) => w.performedAt)
    expect(dates[0] >= dates[1] && dates[1] >= dates[2]).toBe(true) // newest first

    // Date-range filter — only May workouts.
    const rangeRes = await req(
      bearer,
      'GET',
      '/api/v1/ui/workouts?from=2026-05-01T00:00:00.000Z&to=2026-05-31T23:59:59.000Z',
    )
    expect(rangeRes.status).toBe(200)
    const rangeBody = (await rangeRes.json()) as { workouts: WorkoutDto[] }
    expect(rangeBody.workouts).toHaveLength(2)
    expect(rangeBody.workouts.every((w) => w.performedAt.startsWith('2026-05'))).toBe(true)

    // Limit.
    const limitRes = await req(bearer, 'GET', '/api/v1/ui/workouts?limit=1')
    expect(limitRes.status).toBe(200)
    const limitBody = (await limitRes.json()) as { workouts: WorkoutDto[] }
    expect(limitBody.workouts).toHaveLength(1)
    expect(limitBody.workouts[0].performedAt).toContain('2026-06-10')
  })

  it('GET /workouts/:id returns the workout', async () => {
    const bearer = await loginAs('user_wt_get')
    const created = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-15T10:00:00.000Z',
      modality: 'mixed',
      notes: 'Cross-training session',
    })
    const dto = (await created.json()) as WorkoutDto

    const res = await req(bearer, 'GET', `/api/v1/ui/workouts/${dto.id}`)
    expect(res.status).toBe(200)
    const fetched = (await res.json()) as WorkoutDto
    expect(fetched.id).toBe(dto.id)
    expect(fetched.notes).toBe('Cross-training session')
  })

  it('PATCH replaces all sets when sets are provided', async () => {
    const bearer = await loginAs('user_wt_patch')
    // Create with 3 sets.
    const created = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-20T08:00:00.000Z',
      modality: 'strength',
      sets: [
        { exerciseId: knownExerciseId, setIndex: 0, reps: 5, loadKg: 80 },
        { exerciseId: knownExerciseId, setIndex: 1, reps: 5, loadKg: 85 },
        { exerciseId: knownExerciseId, setIndex: 2, reps: 5, loadKg: 90 },
      ],
    })
    const createdDto = (await created.json()) as WorkoutDto
    expect(createdDto.sets).toHaveLength(3)

    // PATCH: update title + replace sets with 2 different sets.
    const patched = await req(bearer, 'PATCH', `/api/v1/ui/workouts/${createdDto.id}`, {
      title: 'Updated Session',
      sets: [
        { exerciseId: knownExerciseId, setIndex: 0, reps: 8, loadKg: 70 },
        { exerciseId: knownExerciseId, setIndex: 1, reps: 8, loadKg: 75 },
      ],
    })
    expect(patched.status).toBe(200)
    const patchedDto = (await patched.json()) as WorkoutDto
    expect(patchedDto.title).toBe('Updated Session')
    expect(patchedDto.sets).toHaveLength(2)
    expect(patchedDto.sets[0].reps).toBe(8)
    expect(patchedDto.sets[0].loadKg).toBe(70)

    // Verify via GET that old sets are gone.
    const got = await req(bearer, 'GET', `/api/v1/ui/workouts/${createdDto.id}`)
    const gotDto = (await got.json()) as WorkoutDto
    expect(gotDto.sets).toHaveLength(2)
  })

  it('PATCH without sets leaves sets unchanged', async () => {
    const bearer = await loginAs('user_wt_patchnosets')
    const created = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-21T08:00:00.000Z',
      modality: 'strength',
      sets: [{ exerciseId: knownExerciseId, setIndex: 0, reps: 5, loadKg: 100 }],
    })
    const dto = (await created.json()) as WorkoutDto

    const patched = await req(bearer, 'PATCH', `/api/v1/ui/workouts/${dto.id}`, {
      notes: 'Added a note',
    })
    expect(patched.status).toBe(200)
    const patchedDto = (await patched.json()) as WorkoutDto
    expect(patchedDto.notes).toBe('Added a note')
    expect(patchedDto.sets).toHaveLength(1) // unchanged
  })

  it('DELETE removes the workout and its sets (cascade), 404 after', async () => {
    const bearer = await loginAs('user_wt_delete')
    const created = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-22T08:00:00.000Z',
      modality: 'conditioning',
      sets: [{ exerciseId: knownExerciseId, setIndex: 0, reps: 20, loadKg: 0 }],
    })
    const dto = (await created.json()) as WorkoutDto

    const del = await req(bearer, 'DELETE', `/api/v1/ui/workouts/${dto.id}`)
    expect(del.status).toBe(200)
    const delBody = (await del.json()) as { ok: boolean }
    expect(delBody.ok).toBe(true)

    // Verify 404 after deletion.
    const get = await req(bearer, 'GET', `/api/v1/ui/workouts/${dto.id}`)
    expect(get.status).toBe(404)

    // Verify list is empty for this user.
    const list = await req(bearer, 'GET', '/api/v1/ui/workouts')
    const listBody = (await list.json()) as { workouts: WorkoutDto[] }
    expect(listBody.workouts).toHaveLength(0)
  })

  it('cross-user isolation: GET returns 404, list excludes other user workouts', async () => {
    const ua = await loginAs('user_wt_iso_a')
    const ub = await loginAs('user_wt_iso_b')

    const created = await req(ua, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-23T08:00:00.000Z',
      modality: 'strength',
    })
    const dto = (await created.json()) as WorkoutDto

    // User B cannot GET user A's workout.
    const getByB = await req(ub, 'GET', `/api/v1/ui/workouts/${dto.id}`)
    expect(getByB.status).toBe(404)

    // User B's list is empty.
    const listByB = await req(ub, 'GET', '/api/v1/ui/workouts')
    const listBody = (await listByB.json()) as { workouts: WorkoutDto[] }
    expect(listBody.workouts).toHaveLength(0)

    // User B cannot PATCH user A's workout.
    const patchByB = await req(ub, 'PATCH', `/api/v1/ui/workouts/${dto.id}`, {
      notes: 'injected',
    })
    expect(patchByB.status).toBe(404)

    // User B cannot DELETE user A's workout.
    const deleteByB = await req(ub, 'DELETE', `/api/v1/ui/workouts/${dto.id}`)
    expect(deleteByB.status).toBe(404)
  })

  it('rejects a set referencing a nonexistent exercise (400)', async () => {
    const bearer = await loginAs('user_wt_badex')
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-24T08:00:00.000Z',
      modality: 'strength',
      sets: [{ exerciseId: 'fx_does_not_exist', reps: 5, loadKg: 100 }],
    })
    expect(res.status).toBe(400)
  })

  it("rejects a set referencing another user's private custom exercise (400)", async () => {
    const ua = await loginAs('user_wt_custex_a')
    const ub = await loginAs('user_wt_custex_b')

    // User A creates a private custom exercise.
    const exRes = await req(ua, 'POST', '/api/v1/ui/exercises', {
      name: 'WtPrivate Lift',
      discipline: 'machine',
      movementPattern: 'isolation',
      metricShape: 'load_reps',
    })
    const exDto = (await exRes.json()) as { id: string }

    // User B tries to reference user A's exercise in a workout.
    const res = await req(ub, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-25T08:00:00.000Z',
      modality: 'strength',
      sets: [{ exerciseId: exDto.id, reps: 5, loadKg: 50 }],
    })
    expect(res.status).toBe(400)
  })

  it('rejects invalid modality and missing performedAt (400)', async () => {
    const bearer = await loginAs('user_wt_invalid')

    const badModality = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-01T09:00:00.000Z',
      modality: 'not_a_modality',
    })
    expect(badModality.status).toBe(400)

    const missingDate = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      modality: 'strength',
    })
    expect(missingDate.status).toBe(400)
  })

  it('rejects an unparseable ?from / ?to query param with 400', async () => {
    const bearer = await loginAs('user_wt_bad_query')
    const badFrom = await req(bearer, 'GET', '/api/v1/ui/workouts?from=garbage')
    expect(badFrom.status).toBe(400)
    const badTo = await req(bearer, 'GET', '/api/v1/ui/workouts?to=not-a-date')
    expect(badTo.status).toBe(400)
  })

  it('payload field round-trips as JSON object', async () => {
    const bearer = await loginAs('user_wt_payload')
    const payload = { wodType: 'AMRAP', timeCapMinutes: 20, result: { rounds: 8, reps: 5 } }
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-26T08:00:00.000Z',
      modality: 'conditioning',
      payload,
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as WorkoutDto
    expect(dto.payload).toEqual(payload)

    // Verify after a GET (goes through DB round-trip).
    const got = await req(bearer, 'GET', `/api/v1/ui/workouts/${dto.id}`)
    const fetched = (await got.json()) as WorkoutDto
    expect(fetched.payload).toEqual(payload)
  })

  it('running set round-trips distance + time + incline + rpe together', async () => {
    const bearer = await loginAs('user_wt_running')
    const weather = {
      temperatureC: 18.2,
      apparentTemperatureC: 17.5,
      windSpeedKmh: 9,
      weatherCode: 1,
      isDay: true,
      fetchedAt: '2026-07-14T07:30:00.000Z',
    }
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-07-14T07:00:00.000Z',
      modality: 'endurance',
      title: 'Morning run',
      payload: { weather },
      sets: [
        {
          exerciseId: knownExerciseId,
          setIndex: 0,
          distanceM: 8046.7,
          timeS: 3120,
          inclinePct: 1.5,
          rpe: 7,
        },
      ],
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as WorkoutDto

    // Verify after a GET (full DB round-trip incl. the incline_pct column).
    const got = await req(bearer, 'GET', `/api/v1/ui/workouts/${dto.id}`)
    const fetched = (await got.json()) as WorkoutDto
    expect(fetched.sets[0]).toMatchObject({
      distanceM: 8046.7,
      timeS: 3120,
      inclinePct: 1.5,
      rpe: 7,
    })
    expect(fetched.payload).toEqual({ weather })

    // List path uses a different SELECT — pin incline there too.
    const list = await req(bearer, 'GET', '/api/v1/ui/workouts')
    const { workouts } = (await list.json()) as { workouts: WorkoutDto[] }
    const mine = workouts.find((w) => w.id === dto.id)
    expect(mine?.sets[0]?.inclinePct).toBe(1.5)
  })

  it('rejects an out-of-range inclinePct (400)', async () => {
    const bearer = await loginAs('user_wt_incline_bad')
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-07-14T07:00:00.000Z',
      modality: 'endurance',
      sets: [{ exerciseId: knownExerciseId, distanceM: 5000, inclinePct: 101 }],
    })
    expect(res.status).toBe(400)
  })

  // --- P3 fix #4: batch exercise visibility check (listForActorByIds) ---

  it('POST rejects a non-visible exercise in a multi-set workout (batch check)', async () => {
    // Ensures that the batched listForActorByIds validation still rejects
    // exercises that are invisible to the actor (P3 fix: serial per-set
    // queries replaced with one IN(..) query + in-memory validation).
    const bearer = await loginAs(`user_wt_batch_reject_${Date.now()}`)
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-27T08:00:00.000Z',
      modality: 'strength',
      sets: [
        { exerciseId: knownExerciseId, setIndex: 0, reps: 5, loadKg: 100 },
        { exerciseId: 'fx_nonexistent_exercise', setIndex: 1, reps: 5, loadKg: 100 },
      ],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  it('POST accepts a multi-set workout where all exercises are visible (batch check)', async () => {
    // Ensures that a valid multi-set POST still succeeds after the batch
    // visibility refactor (behaviour preserved, not just the error path).
    // Seed a second global exercise to reference alongside knownExerciseId.
    const secondId = 'fx_wt_test_global_ex2'
    // Insert idempotently (may already exist from a prior test run on the
    // same DB snapshot — ignore the constraint error if so).
    try {
      await db.insert(exercises).values({
        id: secondId,
        name: 'WT Test Deadlift',
        ownerUserId: null,
        discipline: 'barbell',
        movementPattern: 'hinge',
        metricShape: 'load_reps',
        unilateral: false,
      })
    } catch {
      // Duplicate insert — already seeded, ignore.
    }

    const bearer = await loginAs(`user_wt_batch_ok_${Date.now()}`)
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-06-28T08:00:00.000Z',
      modality: 'strength',
      sets: [
        { exerciseId: knownExerciseId, setIndex: 0, reps: 5, loadKg: 100 },
        { exerciseId: secondId, setIndex: 1, reps: 3, loadKg: 140 },
      ],
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as WorkoutDto
    expect(dto.sets).toHaveLength(2)
  })

  // --- P3 fix #5: limit multiplier cap (limit * 50 → min(limit*50, 500)) --

  it('list respects the limit cap — 500-row scan ceiling is not exceeded', async () => {
    // The repo caps .limit(limit * 50) at 500. With limit=200 (route max),
    // the uncapped value would be 10 000. We can't drive 10k rows in a test,
    // but we can verify that limit=200 still returns at most 200 workouts
    // (the JS grouping gate `order.length >= limit` enforces this).
    // Create 5 workouts to exercise the path; the list should return all
    // of them since 5 < 200.
    const bearer = await loginAs(`user_wt_limit_cap_${Date.now()}`)
    for (let i = 0; i < 5; i++) {
      await req(bearer, 'POST', '/api/v1/ui/workouts', {
        performedAt: new Date(2026, 5, 1 + i, 8).toISOString(),
        modality: 'strength',
        sets: [{ exerciseId: knownExerciseId, reps: 5, loadKg: 100 }],
      })
    }
    const res = await req(bearer, 'GET', '/api/v1/ui/workouts?limit=200')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workouts: WorkoutDto[] }
    expect(body.workouts).toHaveLength(5)
  })

  it('creates a workout with 200 fully-populated sets (chunked past the D1 param cap)', async () => {
    // Regression for "D1_ERROR: too many SQL variables": the schema allows
    // 200 sets × 14 insert columns, far past D1's 100-bound-param cap, so
    // the repo must chunk the multi-row INSERT (and the exercise-visibility
    // inArray) into cap-sized statements.
    const bearer = await loginAs('user_wt_many_sets')
    const sets = Array.from({ length: 200 }, (_, i) => ({
      exerciseId: knownExerciseId,
      setIndex: i,
      reps: 5,
      loadKg: 100 + i,
      calories: 10,
      distanceM: 400,
      timeS: 90,
      inclinePct: 1,
      rounds: 1,
      rpe: 7,
      notes: `set ${i}`,
      setType: 'working' as const,
    }))
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-07-01T09:00:00.000Z',
      modality: 'strength',
      sets,
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as WorkoutDto
    expect(dto.sets).toHaveLength(200)

    // All 200 persisted, in set-index order.
    const got = await req(bearer, 'GET', `/api/v1/ui/workouts/${dto.id}`)
    expect(got.status).toBe(200)
    const fetched = (await got.json()) as WorkoutDto
    expect(fetched.sets).toHaveLength(200)
    expect(fetched.sets.map((s) => s.setIndex)).toEqual(sets.map((s) => s.setIndex))
    expect(fetched.sets[199].loadKg).toBe(299)
  })

  it('PATCH replaces sets with a large (150-set) list without hitting the param cap', async () => {
    const bearer = await loginAs('user_wt_many_sets_patch')
    const created = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-07-02T09:00:00.000Z',
      modality: 'strength',
      sets: [{ exerciseId: knownExerciseId, reps: 5, loadKg: 100 }],
    })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as WorkoutDto

    const sets = Array.from({ length: 150 }, (_, i) => ({
      exerciseId: knownExerciseId,
      setIndex: i,
      reps: 3,
      loadKg: 50 + i,
      rpe: 8,
      notes: `replaced ${i}`,
    }))
    const res = await req(bearer, 'PATCH', `/api/v1/ui/workouts/${id}`, { sets })
    expect(res.status).toBe(200)
    const dto = (await res.json()) as WorkoutDto
    expect(dto.sets).toHaveLength(150)

    const got = await req(bearer, 'GET', `/api/v1/ui/workouts/${id}`)
    const fetched = (await got.json()) as WorkoutDto
    expect(fetched.sets).toHaveLength(150)
    expect(fetched.sets[149].loadKg).toBe(199)
  })
})
