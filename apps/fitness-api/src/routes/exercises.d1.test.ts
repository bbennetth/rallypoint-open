import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { exerciseMuscles, exercises } from '@rallypoint/fitness-db'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the exercise-catalog UI surface. Runs inside a
// workerd isolate (Miniflare D1); migrations — including the seeded
// taxonomy + global catalog — are applied by test/apply-d1-migrations.ts.
// The crucial coverage is the curated-global-vs-private-custom split that
// the two partial unique indexes enforce.

const CSRF = 'csrf_token_value_exercises_aaaaaaaaaaaaaaaa'

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

describe('D1 integration — exercise catalog UI surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let db: Db

  beforeAll(async () => {
    db = createDb(env.DB)
    repos = buildD1Repos(db)
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })

    // A deterministic GLOBAL fixture (owner NULL) so global-path assertions
    // don't depend on the exact seed contents. 'quads' exists from the
    // seeded taxonomy migration.
    await db.insert(exercises).values({
      id: 'fx_test_global_move',
      name: 'ZZ Test Global Move',
      ownerUserId: null,
      discipline: 'barbell',
      movementPattern: 'squat',
      metricShape: 'load_reps',
      unilateral: false,
    })
    await db
      .insert(exerciseMuscles)
      .values({ exerciseId: 'fx_test_global_move', muscleId: 'quads', role: 'primary' })
    // A global whose name a custom row will intentionally collide with.
    await db.insert(exercises).values({
      id: 'fx_test_collision_global',
      name: 'ZZ Collision Move',
      ownerUserId: null,
      discipline: 'dumbbell',
      movementPattern: 'isolation',
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

  it('rejects the catalog without a session (401)', async () => {
    const res = await app.request('http://localhost/api/v1/ui/exercises', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns the 2-level muscle taxonomy from the seed', async () => {
    const bearer = await loginAs('user_tax')
    const res = await req(bearer, 'GET', '/api/v1/ui/muscle-groups')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups: { id: string; muscles: { id: string }[] }[] }
    expect(body.groups.length).toBe(6)
    const legs = body.groups.find((g) => g.id === 'leg')
    expect(legs?.muscles.map((m) => m.id)).toContain('quads')
  })

  it('lists curated globals (incl. the seed) with isCustom=false and resolves muscle maps', async () => {
    const bearer = await loginAs('user_list')
    const res = await req(bearer, 'GET', '/api/v1/ui/exercises')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      exercises: { id: string; name: string; isCustom: boolean; muscles: { muscleId: string }[] }[]
    }
    // The seed migration loads a substantial global catalog.
    expect(body.exercises.length).toBeGreaterThanOrEqual(80)
    expect(body.exercises.every((e) => e.isCustom === false)).toBe(true)
    const fixture = body.exercises.find((e) => e.id === 'fx_test_global_move')
    expect(fixture?.muscles).toContainEqual({ muscleId: 'quads', role: 'primary' })
  })

  it('filters by discipline, muscle group, movement pattern, and search term', async () => {
    const bearer = await loginAs('user_filter')
    const byGroup = await req(bearer, 'GET', '/api/v1/ui/exercises?group=leg')
    const groupBody = (await byGroup.json()) as { exercises: { id: string }[] }
    expect(groupBody.exercises.some((e) => e.id === 'fx_test_global_move')).toBe(true)

    const bySearch = await req(bearer, 'GET', '/api/v1/ui/exercises?q=test%20global')
    const searchBody = (await bySearch.json()) as { exercises: { id: string }[] }
    expect(searchBody.exercises.map((e) => e.id)).toEqual(['fx_test_global_move'])

    const byDiscipline = await req(bearer, 'GET', '/api/v1/ui/exercises?discipline=cardio')
    const discBody = (await byDiscipline.json()) as { exercises: { discipline: string }[] }
    expect(discBody.exercises.every((e) => e.discipline === 'cardio')).toBe(true)

    const byPattern = await req(bearer, 'GET', '/api/v1/ui/exercises?pattern=squat')
    const patBody = (await byPattern.json()) as { exercises: { movementPattern: string }[] }
    expect(patBody.exercises.length).toBeGreaterThan(0)
    expect(patBody.exercises.every((e) => e.movementPattern === 'squat')).toBe(true)
  })

  it('filters by specific muscle (?muscle=), composing with group', async () => {
    const bearer = await loginAs('user_muscle_filter')

    // Every ?muscle=lats hit actually maps lats.
    const byMuscle = await req(bearer, 'GET', '/api/v1/ui/exercises?muscle=lats')
    expect(byMuscle.status).toBe(200)
    const muscleBody = (await byMuscle.json()) as {
      exercises: { muscles: { muscleId: string }[] }[]
    }
    expect(muscleBody.exercises.length).toBeGreaterThan(0)
    expect(
      muscleBody.exercises.every((e) => e.muscles.some((m) => m.muscleId === 'lats')),
    ).toBe(true)

    // muscle narrows group (AND): back+lats ⊆ back.
    const byGroup = await req(bearer, 'GET', '/api/v1/ui/exercises?group=back')
    const groupBody = (await byGroup.json()) as { exercises: { id: string }[] }
    const both = await req(bearer, 'GET', '/api/v1/ui/exercises?group=back&muscle=lats')
    const bothBody = (await both.json()) as { exercises: { id: string }[] }
    expect(bothBody.exercises.length).toBeGreaterThan(0)
    expect(bothBody.exercises.length).toBeLessThanOrEqual(groupBody.exercises.length)
    const groupIds = new Set(groupBody.exercises.map((e) => e.id))
    expect(bothBody.exercises.every((e) => groupIds.has(e.id))).toBe(true)

    // A muscle outside the group yields the intersection, which can be
    // empty but must not error.
    const disjoint = await req(bearer, 'GET', '/api/v1/ui/exercises?group=core&muscle=lats')
    expect(disjoint.status).toBe(200)
  })

  it('rejects an unknown or retired ?muscle= with 400', async () => {
    const bearer = await loginAs('user_bad_muscle')
    const unknown = await req(bearer, 'GET', '/api/v1/ui/exercises?muscle=nope')
    expect(unknown.status).toBe(400)
    // Retired pre-0030 slug is no longer valid.
    const retired = await req(bearer, 'GET', '/api/v1/ui/exercises?muscle=rear_delt')
    expect(retired.status).toBe(400)
  })

  it('serves the batch-2 seed top-up (0014) — T-Bar Row searchable with muscle map', async () => {
    const bearer = await loginAs('user_batch2')
    const res = await req(bearer, 'GET', '/api/v1/ui/exercises?q=t-bar')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      exercises: { id: string; name: string; isCustom: boolean; muscles: { muscleId: string }[] }[]
    }
    const tbar = body.exercises.find((e) => e.id === 'fx_seed_t_bar_row')
    expect(tbar).toBeDefined()
    expect(tbar).toMatchObject({ name: 'T-Bar Row', isCustom: false })
    expect(tbar!.muscles).toContainEqual({ muscleId: 'lats', role: 'primary' })
  })

  it('rejects unknown discipline / group / pattern with 400', async () => {
    const bearer = await loginAs('user_bad_filter')
    const badDiscipline = await req(bearer, 'GET', '/api/v1/ui/exercises?discipline=barbel')
    expect(badDiscipline.status).toBe(400)
    const badGroup = await req(bearer, 'GET', '/api/v1/ui/exercises?group=nope')
    expect(badGroup.status).toBe(400)
    const badPattern = await req(bearer, 'GET', '/api/v1/ui/exercises?pattern=jumpsies')
    expect(badPattern.status).toBe(400)
  })

  it('creates a private custom exercise with its muscle map', async () => {
    const bearer = await loginAs('user_a')
    const res = await req(bearer, 'POST', '/api/v1/ui/exercises', {
      name: 'My Sled Drag',
      discipline: 'bodyweight',
      movementPattern: 'carry',
      metricShape: 'distance_time',
      muscles: [
        { muscleId: 'quads', role: 'primary' },
        { muscleId: 'glutes', role: 'secondary' },
      ],
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as { id: string; isCustom: boolean; muscles: unknown[] }
    expect(dto.isCustom).toBe(true)
    expect(dto.muscles).toHaveLength(2)

    const got = await req(bearer, 'GET', `/api/v1/ui/exercises/${dto.id}`)
    expect(got.status).toBe(200)
  })

  it("keeps a user's custom exercises private to that user", async () => {
    const ua = await loginAs('user_priv_a')
    const created = await req(ua, 'POST', '/api/v1/ui/exercises', {
      name: 'Secret Movement',
      discipline: 'machine',
      movementPattern: 'isolation',
      metricShape: 'load_reps',
    })
    const { id } = (await created.json()) as { id: string }

    const ub = await loginAs('user_priv_b')
    const list = await req(ub, 'GET', '/api/v1/ui/exercises')
    const body = (await list.json()) as { exercises: { id: string }[] }
    expect(body.exercises.some((e) => e.id === id)).toBe(false)
    const direct = await req(ub, 'GET', `/api/v1/ui/exercises/${id}`)
    expect(direct.status).toBe(404)
  })

  it('find-or-create is idempotent per owner (200, same id, never 500)', async () => {
    const bearer = await loginAs('user_idem')
    const first = await req(bearer, 'POST', '/api/v1/ui/exercises', {
      name: 'Repeated Move',
      discipline: 'kettlebell',
      movementPattern: 'hinge',
      metricShape: 'load_reps',
    })
    expect(first.status).toBe(201)
    const a = (await first.json()) as { id: string }
    // Re-submit with cosmetic whitespace variation — normalization collapses it.
    const second = await req(bearer, 'POST', '/api/v1/ui/exercises', {
      name: '  Repeated   Move ',
      discipline: 'kettlebell',
      movementPattern: 'hinge',
      metricShape: 'load_reps',
    })
    expect(second.status).toBe(200)
    const b = (await second.json()) as { id: string }
    expect(b.id).toBe(a.id)
  })

  it('allows the same custom name across two different users (per-owner uniqueness)', async () => {
    const ua = await loginAs('user_dup_a')
    const ub = await loginAs('user_dup_b')
    const ra = await req(ua, 'POST', '/api/v1/ui/exercises', {
      name: 'Shared Name Move',
      discipline: 'cable',
      movementPattern: 'horizontal_pull',
      metricShape: 'load_reps',
    })
    const rb = await req(ub, 'POST', '/api/v1/ui/exercises', {
      name: 'Shared Name Move',
      discipline: 'cable',
      movementPattern: 'horizontal_pull',
      metricShape: 'load_reps',
    })
    expect(ra.status).toBe(201)
    expect(rb.status).toBe(201)
    const ida = (await ra.json()) as { id: string }
    const idb = (await rb.json()) as { id: string }
    expect(ida.id).not.toBe(idb.id)
  })

  it('allows a custom name that collides with a curated global name', async () => {
    const bearer = await loginAs('user_collide')
    const res = await req(bearer, 'POST', '/api/v1/ui/exercises', {
      name: 'ZZ Collision Move', // same name as the global fixture
      discipline: 'dumbbell',
      movementPattern: 'isolation',
      metricShape: 'load_reps',
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as { id: string; isCustom: boolean }
    expect(dto.isCustom).toBe(true)
    expect(dto.id).not.toBe('fx_test_collision_global')
  })

  it('rejects an unknown muscle id and an invalid enum (400)', async () => {
    const bearer = await loginAs('user_invalid')
    const badMuscle = await req(bearer, 'POST', '/api/v1/ui/exercises', {
      name: 'Bad Muscle Move',
      discipline: 'barbell',
      movementPattern: 'squat',
      metricShape: 'load_reps',
      muscles: [{ muscleId: 'not_a_muscle', role: 'primary' }],
    })
    expect(badMuscle.status).toBe(400)

    const badEnum = await req(bearer, 'POST', '/api/v1/ui/exercises', {
      name: 'Bad Enum Move',
      discipline: 'spaceship',
      movementPattern: 'squat',
      metricShape: 'load_reps',
    })
    expect(badEnum.status).toBe(400)
  })

  it('PATCHes own custom exercise (rename + muscle-map replace); global rows 404', async () => {
    const bearer = await loginAs('user_patch')
    const created = await req(bearer, 'POST', '/api/v1/ui/exercises', {
      name: 'Patchable Move',
      discipline: 'kettlebell',
      movementPattern: 'hinge',
      metricShape: 'load_reps',
      muscles: [{ muscleId: 'quads', role: 'primary' }],
    })
    expect(created.status).toBe(201)
    const dto = (await created.json()) as { id: string }

    const patched = await req(bearer, 'PATCH', `/api/v1/ui/exercises/${dto.id}`, {
      name: 'Patched Move',
      unilateral: true,
      muscles: [{ muscleId: 'glutes', role: 'primary' }],
    })
    expect(patched.status).toBe(200)
    const pd = (await patched.json()) as {
      name: string
      unilateral: boolean
      muscles: { muscleId: string }[]
    }
    expect(pd.name).toBe('Patched Move')
    expect(pd.unilateral).toBe(true)
    expect(pd.muscles).toEqual([{ muscleId: 'glutes', role: 'primary' }])

    // Global rows are not patchable — 404, not 403 (no existence leak).
    const globalPatch = await req(bearer, 'PATCH', '/api/v1/ui/exercises/fx_test_global_move', {
      name: 'Hijacked',
    })
    expect(globalPatch.status).toBe(404)
    // Empty patch is a 400.
    const empty = await req(bearer, 'PATCH', `/api/v1/ui/exercises/${dto.id}`, {})
    expect(empty.status).toBe(400)
  })

  it("PATCH cannot touch another user's custom row (404)", async () => {
    const owner = await loginAs('user_patch_owner')
    const created = await req(owner, 'POST', '/api/v1/ui/exercises', {
      name: 'Not Yours',
      discipline: 'bodyweight',
      movementPattern: 'core',
      metricShape: 'duration',
    })
    const dto = (await created.json()) as { id: string }
    const intruder = await loginAs('user_patch_intruder')
    const res = await req(intruder, 'PATCH', `/api/v1/ui/exercises/${dto.id}`, {
      name: 'Mine Now',
    })
    expect(res.status).toBe(404)
  })

  it('PATCH rename onto an existing custom name conflicts (409)', async () => {
    const bearer = await loginAs('user_patch_dup')
    const a = (await (
      await req(bearer, 'POST', '/api/v1/ui/exercises', {
        name: 'Dup A',
        discipline: 'barbell',
        movementPattern: 'squat',
        metricShape: 'load_reps',
      })
    ).json()) as { id: string }
    await req(bearer, 'POST', '/api/v1/ui/exercises', {
      name: 'Dup B',
      discipline: 'barbell',
      movementPattern: 'squat',
      metricShape: 'load_reps',
    })
    const res = await req(bearer, 'PATCH', `/api/v1/ui/exercises/${a.id}`, { name: 'Dup B' })
    expect(res.status).toBe(409)
  })

  it('DELETEs own custom exercise; blocks when history references it; global 404', async () => {
    const bearer = await loginAs('user_delete')
    const freeDto = (await (
      await req(bearer, 'POST', '/api/v1/ui/exercises', {
        name: 'Deletable Move',
        discipline: 'cardio',
        movementPattern: 'gait',
        metricShape: 'distance_time',
      })
    ).json()) as { id: string }
    const usedDto = (await (
      await req(bearer, 'POST', '/api/v1/ui/exercises', {
        name: 'Used Move',
        discipline: 'bodyweight',
        movementPattern: 'core',
        metricShape: 'load_reps',
      })
    ).json()) as { id: string }

    // Log a workout referencing usedDto so the delete is blocked.
    const workout = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: new Date().toISOString(),
      modality: 'strength',
      sets: [{ exerciseId: usedDto.id, setIndex: 0, reps: 5 }],
    })
    expect(workout.status).toBe(201)

    const blocked = await req(bearer, 'DELETE', `/api/v1/ui/exercises/${usedDto.id}`)
    expect(blocked.status).toBe(409)

    const ok = await req(bearer, 'DELETE', `/api/v1/ui/exercises/${freeDto.id}`)
    expect(ok.status).toBe(200)
    const gone = await req(bearer, 'GET', `/api/v1/ui/exercises/${freeDto.id}`)
    expect(gone.status).toBe(404)

    const globalDel = await req(bearer, 'DELETE', '/api/v1/ui/exercises/fx_test_global_move')
    expect(globalDel.status).toBe(404)
  })

  // --- recent-sets history (GET /:id/history) --------------------------

  interface HistoryResp {
    exerciseId: string
    exerciseName: string
    sessions: {
      workoutId: string
      workoutTitle: string | null
      performedAt: string
      sets: { reps: number | null; loadKg: number | null; rpe: number | null }[]
    }[]
  }

  it('returns recent sessions newest-first, working sets only', async () => {
    const bearer = await loginAs('user_hist_a')
    const ex = 'fx_test_global_move'

    // Older session: two working sets + one warmup (warmup must be excluded).
    const older = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-07-01T10:00:00.000Z',
      modality: 'strength',
      title: 'Old Day',
      sets: [
        { exerciseId: ex, setIndex: 0, reps: 5, loadKg: 60, setType: 'warmup' },
        { exerciseId: ex, setIndex: 1, reps: 5, loadKg: 100, rpe: 7 },
        { exerciseId: ex, setIndex: 2, reps: 5, loadKg: 100, rpe: 8 },
      ],
    })
    expect(older.status).toBe(201)

    // Newer session: one working set.
    const newer = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-07-08T10:00:00.000Z',
      modality: 'strength',
      title: 'New Day',
      sets: [{ exerciseId: ex, setIndex: 0, reps: 3, loadKg: 110, rpe: 9 }],
    })
    expect(newer.status).toBe(201)

    const res = await req(bearer, 'GET', `/api/v1/ui/exercises/${ex}/history`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryResp
    expect(body.exerciseId).toBe(ex)
    expect(body.exerciseName).toBe('ZZ Test Global Move')

    // Newest session first.
    expect(body.sessions.map((s) => s.performedAt)).toEqual([
      '2026-07-08T10:00:00.000Z',
      '2026-07-01T10:00:00.000Z',
    ])
    // Newer session: the single working set.
    expect(body.sessions[0]!.sets).toEqual([{ reps: 3, loadKg: 110, rpe: 9 }])
    // Older session: warmup dropped, two working sets in setIndex order.
    expect(body.sessions[1]!.sets).toEqual([
      { reps: 5, loadKg: 100, rpe: 7 },
      { reps: 5, loadKg: 100, rpe: 8 },
    ])
  })

  it('respects the limit query (number of sessions)', async () => {
    const bearer = await loginAs('user_hist_limit')
    const ex = 'fx_test_global_move'
    for (const d of ['2026-05-01', '2026-05-02', '2026-05-03']) {
      const r = await req(bearer, 'POST', '/api/v1/ui/workouts', {
        performedAt: `${d}T10:00:00.000Z`,
        modality: 'strength',
        sets: [{ exerciseId: ex, setIndex: 0, reps: 5, loadKg: 90 }],
      })
      expect(r.status).toBe(201)
    }
    const res = await req(bearer, 'GET', `/api/v1/ui/exercises/${ex}/history?limit=2`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryResp
    expect(body.sessions).toHaveLength(2)
    expect(body.sessions.map((s) => s.performedAt)).toEqual([
      '2026-05-03T10:00:00.000Z',
      '2026-05-02T10:00:00.000Z',
    ])
  })

  it('is scoped to the actor (another user sees no history)', async () => {
    const owner = await loginAs('user_hist_owner')
    const other = await loginAs('user_hist_other')
    const ex = 'fx_test_collision_global'
    const posted = await req(owner, 'POST', '/api/v1/ui/workouts', {
      performedAt: '2026-04-01T10:00:00.000Z',
      modality: 'strength',
      sets: [{ exerciseId: ex, setIndex: 0, reps: 5, loadKg: 50 }],
    })
    expect(posted.status).toBe(201)
    const res = await req(other, 'GET', `/api/v1/ui/exercises/${ex}/history`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryResp
    expect(body.sessions).toEqual([])
  })

  it('404s an exercise the actor cannot see', async () => {
    const bearer = await loginAs('user_hist_404')
    const res = await req(bearer, 'GET', '/api/v1/ui/exercises/fx_does_not_exist/history')
    expect(res.status).toBe(404)
  })

  it('rejects history without a session (401)', async () => {
    const res = await app.request(
      'http://localhost/api/v1/ui/exercises/fx_test_global_move/history',
      { headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` } },
    )
    expect(res.status).toBe(401)
  })
})
