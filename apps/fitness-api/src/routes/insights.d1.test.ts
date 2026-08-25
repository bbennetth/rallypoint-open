import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { exercises, exerciseMuscles } from '@rallypoint/fitness-db'
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
import type { MuscleGroupVolume, MuscleVolume, ExercisePr } from '@rallypoint/fitness-shared'
import { MUSCLES } from '@rallypoint/fitness-shared'

// D1 integration tests for the derived training insights UI surface (slice 4).
// Runs inside a workerd isolate (Miniflare D1); migrations are applied by
// test/apply-d1-migrations.ts. Seeding is done by POSTing workouts through the
// existing route to keep the two test surfaces in sync.
//
// Muscle taxonomy used in assertions (post-0030 collapse):
//   'leg' group  → muscles: quads (primary), hamstrings, glutes, calves
//   'chest' group → muscles: chest
//   'back' group  → muscles: lats, traps, erectors

const CSRF = 'csrf_token_value_insights_aaaaaaaaaaaaaaa'

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

describe('D1 integration — insights UI surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let db: Db

  // Two exercises we seed with known muscle maps.
  // squat_ex: quads (primary) + glutes (secondary)
  // bench_ex: chest (primary) + delts (secondary)
  // run_ex:   no muscle map (cardio)
  let squat_ex_id: string
  let bench_ex_id: string
  let run_ex_id: string

  beforeAll(async () => {
    db = createDb(env.DB)
    repos = buildD1Repos(db)
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })

    // Seed exercises with known muscle maps.
    squat_ex_id = 'fx_ins_test_squat'
    bench_ex_id = 'fx_ins_test_bench'
    run_ex_id = 'fx_ins_test_run'

    await db.insert(exercises).values([
      {
        id: squat_ex_id,
        name: 'INS Test Squat',
        ownerUserId: null,
        discipline: 'barbell',
        movementPattern: 'squat',
        metricShape: 'load_reps',
        unilateral: false,
      },
      {
        id: bench_ex_id,
        name: 'INS Test Bench',
        ownerUserId: null,
        discipline: 'barbell',
        movementPattern: 'horizontal_push',
        metricShape: 'load_reps',
        unilateral: false,
      },
      {
        id: run_ex_id,
        name: 'INS Test Run',
        ownerUserId: null,
        discipline: 'cardio',
        movementPattern: 'gait',
        metricShape: 'distance_time',
        unilateral: false,
      },
    ])

    // Squat: quads (primary), glutes (secondary)
    await db.insert(exerciseMuscles).values([
      { exerciseId: squat_ex_id, muscleId: 'quads', role: 'primary' },
      { exerciseId: squat_ex_id, muscleId: 'glutes', role: 'secondary' },
    ])
    // Bench: chest (primary), delts (secondary)
    await db.insert(exerciseMuscles).values([
      { exerciseId: bench_ex_id, muscleId: 'chest', role: 'primary' },
      { exerciseId: bench_ex_id, muscleId: 'delts', role: 'secondary' },
    ])
    // Run: no muscle maps (cardio — intentionally empty)
  })

  // ---- helpers --------------------------------------------------------

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

  async function postWorkout(
    bearer: string,
    performedAt: string,
    sets: {
      exerciseId: string
      reps?: number
      loadKg?: number
      distanceM?: number
      timeS?: number
      setType?: 'warmup' | 'working'
    }[],
  ): Promise<WorkoutDto> {
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt,
      modality: 'strength',
      sets: sets.map((s, i) => ({ setIndex: i, ...s })),
    })
    expect(res.status).toBe(201)
    return res.json() as Promise<WorkoutDto>
  }

  // ---- 401 without session -------------------------------------------

  it('rejects volume without a session (401)', async () => {
    const res = await app.request('http://localhost/api/v1/ui/insights/volume', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('rejects prs without a session (401)', async () => {
    const res = await app.request('http://localhost/api/v1/ui/insights/prs', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  // ---- volume: correct muscle-group credits --------------------------

  it('volume: credits the right muscle groups with correct weightedSets and tonnage', async () => {
    const bearer = await loginAs('user_ins_vol_credits')

    // Post 2 squat sets (100 kg × 5 reps) + 1 bench set (80 kg × 8 reps).
    const from = '2026-06-20T00:00:00.000Z'
    const to = '2026-06-27T23:59:59.000Z'

    await postWorkout(bearer, '2026-06-25T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
    ])
    await postWorkout(bearer, '2026-06-26T10:00:00.000Z', [
      { exerciseId: bench_ex_id, reps: 8, loadKg: 80 },
    ])

    const res = await req(bearer, 'GET', `/api/v1/ui/insights/volume?from=${from}&to=${to}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { from: string; to: string; groups: MuscleGroupVolume[] }

    expect(body.from).toBe(from)
    expect(body.to).toBe(to)

    // All 6 taxonomy groups must be present (even zero-volume ones).
    expect(body.groups).toHaveLength(6)
    const byGroup = new Map(body.groups.map((g) => [g.groupId, g]))

    // Legs — quads primary (1.0 × 2 sets) = 2 weightedSets;
    //         glutes secondary (0.5 × 2 sets) = 1 — but groupMax is per-set max,
    //         so leg group gets max(quads=1.0, glutes=0.5) = 1.0 per set = 2.
    const leg = byGroup.get('leg')!
    expect(leg.weightedSets).toBeCloseTo(2)
    // tonnage = 2 sets × (5 × 100) × 1.0 = 1000
    expect(leg.tonnageKg).toBeCloseTo(1000)

    // Chest — chest primary (1.0 × 1 set) = 1 weightedSet
    const chest = byGroup.get('chest')!
    expect(chest.weightedSets).toBeCloseTo(1)
    // tonnage = 1 set × (8 × 80) × 1.0 = 640
    expect(chest.tonnageKg).toBeCloseTo(640)

    // Shoulders — delts is secondary in bench_ex (0.5 × 1 set) = 0.5
    const shoulder = byGroup.get('shoulder')!
    expect(shoulder.weightedSets).toBeCloseTo(0.5)

    // Back, Arms, Core — zero
    expect(byGroup.get('back')!.weightedSets).toBe(0)
    expect(byGroup.get('arm')!.weightedSets).toBe(0)
    expect(byGroup.get('core')!.weightedSets).toBe(0)
  })

  // ---- volume: per-muscle breakdown ----------------------------------

  it('volume: returns a per-muscle breakdown alongside the group rollup', async () => {
    const bearer = await loginAs('user_ins_vol_muscles')

    const from = '2026-06-20T00:00:00.000Z'
    const to = '2026-06-27T23:59:59.000Z'

    // 2 squat sets (quads primary, glutes secondary) + 1 bench set
    // (chest primary, delts secondary).
    await postWorkout(bearer, '2026-06-25T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
    ])
    await postWorkout(bearer, '2026-06-26T10:00:00.000Z', [
      { exerciseId: bench_ex_id, reps: 8, loadKg: 80 },
    ])

    const res = await req(bearer, 'GET', `/api/v1/ui/insights/volume?from=${from}&to=${to}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      groups: MuscleGroupVolume[]
      muscles: MuscleVolume[]
    }

    // Full taxonomy, zero-filled, each entry tagged with its group.
    expect(body.muscles).toHaveLength(MUSCLES.length)
    const byMuscle = new Map(body.muscles.map((m) => [m.muscleId, m]))

    // quads primary: 1.0 × 2 sets; tonnage 2 × 500 × 1.0.
    expect(byMuscle.get('quads')!.weightedSets).toBeCloseTo(2)
    expect(byMuscle.get('quads')!.tonnageKg).toBeCloseTo(1000)
    // glutes secondary: 0.5 × 2 sets.
    expect(byMuscle.get('glutes')!.weightedSets).toBeCloseTo(1)
    // chest primary: 1 set; delts secondary: 0.5.
    expect(byMuscle.get('chest')!.weightedSets).toBeCloseTo(1)
    expect(byMuscle.get('chest')!.tonnageKg).toBeCloseTo(640)
    expect(byMuscle.get('delts')!.weightedSets).toBeCloseTo(0.5)
    expect(byMuscle.get('delts')!.groupId).toBe('shoulder')
    // Untouched muscles present with zeros.
    expect(byMuscle.get('biceps')!.weightedSets).toBe(0)

    // Group rollup unchanged alongside.
    const leg = body.groups.find((g) => g.groupId === 'leg')!
    expect(leg.weightedSets).toBeCloseTo(2)
  })

  // ---- volume: window filter -----------------------------------------

  it('volume: window filter excludes out-of-range workouts', async () => {
    const bearer = await loginAs('user_ins_vol_window')

    // Workout inside window (June 25).
    await postWorkout(bearer, '2026-06-25T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
    ])
    // Workout outside window — June 10 (before the from date).
    await postWorkout(bearer, '2026-06-10T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 200 },
    ])

    const from = '2026-06-20T00:00:00.000Z'
    const to = '2026-06-27T23:59:59.000Z'
    const res = await req(bearer, 'GET', `/api/v1/ui/insights/volume?from=${from}&to=${to}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups: MuscleGroupVolume[] }

    const leg = body.groups.find((g) => g.groupId === 'leg')!
    // Only the in-window set should count (1 set × 5 reps × 100 kg = 500 tonnage).
    expect(leg.weightedSets).toBeCloseTo(1)
    expect(leg.tonnageKg).toBeCloseTo(500)
  })

  // ---- volume: warmup sets are excluded --------------------------------

  it('volume: warmup sets are excluded from tonnage and weightedSets', async () => {
    const bearer = await loginAs('user_ins_vol_warmup')

    const from = '2026-06-20T00:00:00.000Z'
    const to = '2026-06-27T23:59:59.000Z'

    await postWorkout(bearer, '2026-06-25T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 40, setType: 'warmup' },
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
    ])

    const res = await req(bearer, 'GET', `/api/v1/ui/insights/volume?from=${from}&to=${to}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups: MuscleGroupVolume[] }
    const leg = body.groups.find((g) => g.groupId === 'leg')!
    // Only the 'working' set counts: 1 set × 5 reps × 100 kg = 500.
    expect(leg.weightedSets).toBeCloseTo(1)
    expect(leg.tonnageKg).toBeCloseTo(500)
  })

  // ---- volume: cardio sets with no muscle maps -----------------------

  it('volume: run sets (no muscle maps) produce zero volume everywhere', async () => {
    const bearer = await loginAs('user_ins_vol_cardio')

    await postWorkout(bearer, '2026-06-25T10:00:00.000Z', [
      { exerciseId: run_ex_id, distanceM: 5000, timeS: 1500 },
    ])

    const from = '2026-06-20T00:00:00.000Z'
    const to = '2026-06-27T23:59:59.000Z'
    const res = await req(bearer, 'GET', `/api/v1/ui/insights/volume?from=${from}&to=${to}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups: MuscleGroupVolume[] }

    // All groups zero.
    expect(body.groups.every((g) => g.weightedSets === 0)).toBe(true)
  })

  // ---- PRs: best e1RM, heaviest load, longest distance, fastest time ---

  it('prs: reflects best e1RM + heaviest load per exercise', async () => {
    const bearer = await loginAs('user_ins_prs_basic')

    // Three squat sets at different loads/reps.
    await postWorkout(bearer, '2026-06-24T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },   // e1RM ≈ 116.7
      { exerciseId: squat_ex_id, reps: 1, loadKg: 130 },   // e1RM = 130 (single)
      { exerciseId: squat_ex_id, reps: 10, loadKg: 90 },   // e1RM ≈ 120
    ])

    const res = await req(bearer, 'GET', '/api/v1/ui/insights/prs')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      exercises: Array<{ exerciseId: string; exerciseName: string } & ExercisePr>
    }

    const squat = body.exercises.find((e) => e.exerciseId === squat_ex_id)
    expect(squat).toBeDefined()
    // best e1RM is 90 × (1 + 10/30) = 120, compared to 130 (single) → 130 wins
    expect(squat!.bestE1rmKg).toBeCloseTo(130)
    expect(squat!.heaviestLoadKg).toBeCloseTo(130)
  })

  it('prs: warmup sets never win the PR even when heaviest', async () => {
    const bearer = await loginAs('user_ins_prs_warmup')

    await postWorkout(bearer, '2026-06-24T10:00:00.000Z', [
      // Heaviest of all — but marked warmup, so it must not surface.
      { exerciseId: squat_ex_id, reps: 1, loadKg: 500, setType: 'warmup' },
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
    ])

    const res = await req(bearer, 'GET', '/api/v1/ui/insights/prs')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      exercises: Array<{ exerciseId: string; exerciseName: string } & ExercisePr>
    }
    const squat = body.exercises.find((e) => e.exerciseId === squat_ex_id)
    expect(squat).toBeDefined()
    expect(squat!.heaviestLoadKg).toBeCloseTo(100)
  })

  it('prs: reflects longest distance and fastest time for endurance exercises', async () => {
    const bearer = await loginAs('user_ins_prs_endurance')

    await postWorkout(bearer, '2026-06-24T10:00:00.000Z', [
      { exerciseId: run_ex_id, distanceM: 5000, timeS: 1800 },
      { exerciseId: run_ex_id, distanceM: 10000, timeS: 3600 },
      { exerciseId: run_ex_id, distanceM: 3000, timeS: 900 },  // fastest (900s)
    ])

    const res = await req(bearer, 'GET', '/api/v1/ui/insights/prs')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      exercises: Array<{ exerciseId: string; exerciseName: string } & ExercisePr>
    }

    const run = body.exercises.find((e) => e.exerciseId === run_ex_id)
    expect(run).toBeDefined()
    expect(run!.longestDistanceM).toBe(10000)
    expect(run!.fastestTimeS).toBe(900)
  })

  it('prs: exercises sorted by name', async () => {
    const bearer = await loginAs('user_ins_prs_sort')

    // Post workouts for both squat and bench so both appear in PRs.
    await postWorkout(bearer, '2026-06-24T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
      { exerciseId: bench_ex_id, reps: 5, loadKg: 80 },
    ])

    const res = await req(bearer, 'GET', '/api/v1/ui/insights/prs')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      exercises: Array<{ exerciseId: string; exerciseName: string } & ExercisePr>
    }

    const names = body.exercises.map((e) => e.exerciseName)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    expect(names).toEqual(sorted)
  })

  // ---- cross-user isolation ------------------------------------------

  it('cross-user isolation: another user sees zero volume and no PRs', async () => {
    const ua = await loginAs('user_ins_iso_a')
    const ub = await loginAs('user_ins_iso_b')

    // User A logs a workout.
    await postWorkout(ua, '2026-06-25T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 120 },
    ])

    // User B queries volume — should be all zeros.
    const from = '2026-06-20T00:00:00.000Z'
    const to = '2026-06-27T23:59:59.000Z'
    const volRes = await req(ub, 'GET', `/api/v1/ui/insights/volume?from=${from}&to=${to}`)
    expect(volRes.status).toBe(200)
    const volBody = (await volRes.json()) as { groups: MuscleGroupVolume[] }
    expect(volBody.groups.every((g) => g.weightedSets === 0)).toBe(true)

    // User B queries PRs — should be empty.
    const prsRes = await req(ub, 'GET', '/api/v1/ui/insights/prs')
    expect(prsRes.status).toBe(200)
    const prsBody = (await prsRes.json()) as { exercises: unknown[] }
    expect(prsBody.exercises).toHaveLength(0)
  })

  // ---- volume: default window (no params) ----------------------------

  it('volume + prs: WOD-style rep-only sets (conditioning modality) flow into insights', async () => {
    // Mirrors what WodSessionPage now persists on save: one aggregate
    // rep-only set per movement under modality='conditioning'.
    const bearer = await loginAs('user_ins_wod_sets')
    const performedAt = new Date().toISOString()
    const res = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt,
      modality: 'conditioning',
      title: 'Fran-ish',
      sets: [
        { exerciseId: squat_ex_id, setIndex: 0, reps: 45, loadKg: 43 },
        { exerciseId: bench_ex_id, setIndex: 1, reps: 45 },
      ],
    })
    expect(res.status).toBe(201)

    const vol = await req(bearer, 'GET', '/api/v1/ui/insights/volume')
    const volBody = (await vol.json()) as { groups: MuscleGroupVolume[] }
    const leg = volBody.groups.find((g) => g.groupId === 'leg')!
    // Loaded WOD set carries tonnage; rep-only set still credits its
    // group with a weighted set (tonnage 0).
    expect(leg.weightedSets).toBeGreaterThan(0)
    expect(leg.tonnageKg).toBeCloseTo(45 * 43)
    const chest = volBody.groups.find((g) => g.groupId === 'chest')!
    expect(chest.weightedSets).toBeGreaterThan(0)
    expect(chest.tonnageKg).toBe(0)

    const prs = await req(bearer, 'GET', '/api/v1/ui/insights/prs')
    const prsBody = (await prs.json()) as {
      exercises: { exerciseId: string; bestE1rmKg: number | null }[]
    }
    const squatPr = prsBody.exercises.find((e) => e.exerciseId === squat_ex_id)
    expect(squatPr?.bestE1rmKg).not.toBeNull()
    // Rep-only set yields an all-null PR row — present but nullable
    // (the UI filters those out of the PR list).
    const benchPr = prsBody.exercises.find((e) => e.exerciseId === bench_ex_id)
    expect(benchPr?.bestE1rmKg).toBeNull()
  })

  it('volume: default window (no from/to) returns a valid response', async () => {
    const bearer = await loginAs('user_ins_vol_default')

    const res = await req(bearer, 'GET', '/api/v1/ui/insights/volume')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { from: string; to: string; groups: MuscleGroupVolume[] }

    // from should be approximately 7 days before to.
    const fromMs = new Date(body.from).getTime()
    const toMs = new Date(body.to).getTime()
    const diffDays = (toMs - fromMs) / (24 * 60 * 60 * 1000)
    expect(diffDays).toBeCloseTo(7, 0)
    expect(body.groups).toHaveLength(6)
  })

  it('volume: rejects an unparseable ?from / ?to with 400 (not 500)', async () => {
    const bearer = await loginAs('user_ins_bad_query')
    const badFrom = await req(bearer, 'GET', '/api/v1/ui/insights/volume?from=garbage')
    expect(badFrom.status).toBe(400)
    const badTo = await req(bearer, 'GET', '/api/v1/ui/insights/volume?to=not-a-date')
    expect(badTo.status).toBe(400)
  })

  it('volume + prs set a short private Cache-Control header', async () => {
    const bearer = await loginAs('user_ins_cache')
    const vol = await req(bearer, 'GET', '/api/v1/ui/insights/volume')
    expect(vol.headers.get('cache-control')).toBe('private, max-age=60')
    const prs = await req(bearer, 'GET', '/api/v1/ui/insights/prs')
    expect(prs.headers.get('cache-control')).toBe('private, max-age=60')
  })

  it('volume: window upper bound is exclusive (half-open) — matches UI local-day windowing', async () => {
    const bearer = await loginAs('user_ins_half_open')

    // A workout performed exactly on the `to` boundary should NOT be counted —
    // the UI sends `to` = local midnight of tomorrow, and a set at that
    // instant would belong to the NEXT day's window.
    const boundary = '2026-06-27T00:00:00.000Z'
    await postWorkout(bearer, boundary, [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 999 },
    ])
    // And a workout just before the boundary that should be counted.
    await postWorkout(bearer, '2026-06-26T23:59:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
    ])

    const from = '2026-06-20T00:00:00.000Z'
    const res = await req(bearer, 'GET', `/api/v1/ui/insights/volume?from=${from}&to=${boundary}`)
    const body = (await res.json()) as { groups: MuscleGroupVolume[] }
    const leg = body.groups.find((g) => g.groupId === 'leg')!
    // Only the 5×100 set in-window should contribute; the 5×999 set sitting
    // on the exclusive upper bound is dropped (tonnage = 500, not 5495).
    expect(leg.tonnageKg).toBeCloseTo(500)
  })

  // ---- volume/weekly: the Stats 8-week bar chart ----------------------

  interface WeeklyBody {
    from: string
    to: string
    weeks: { from: string; to: string; tonnageKg: number; sets: number }[]
  }

  it('weekly: rejects without a session (401)', async () => {
    const res = await app.request('http://localhost/api/v1/ui/insights/volume/weekly', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('weekly: buckets sets into anchored 7-day bins with empty bins zeroed', async () => {
    const bearer = await loginAs('user_ins_weekly_bins')

    // 3-week window anchored Mon 2026-06-08. Week 0 gets two sets, week 1
    // stays empty, week 2 gets one set + one exactly on the week-1/2
    // boundary (half-open: belongs to week 2).
    await postWorkout(bearer, '2026-06-09T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
      { exerciseId: bench_ex_id, reps: 8, loadKg: 50 },
    ])
    await postWorkout(bearer, '2026-06-22T00:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 3, loadKg: 120 },
    ])
    await postWorkout(bearer, '2026-06-24T18:00:00.000Z', [
      { exerciseId: bench_ex_id, reps: 10, loadKg: 40 },
    ])

    const res = await req(
      bearer,
      'GET',
      '/api/v1/ui/insights/volume/weekly?from=2026-06-08T00:00:00.000Z&to=2026-06-29T00:00:00.000Z',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as WeeklyBody
    expect(body.weeks).toHaveLength(3)
    expect(body.weeks[0]).toMatchObject({ tonnageKg: 900, sets: 2 }) // 500 + 400
    expect(body.weeks[1]).toMatchObject({ tonnageKg: 0, sets: 0 })
    expect(body.weeks[2]).toMatchObject({ tonnageKg: 760, sets: 2 }) // 360 + 400
    expect(body.weeks[0]!.from).toBe('2026-06-08T00:00:00.000Z')
    expect(body.weeks[2]!.to).toBe('2026-06-29T00:00:00.000Z')
  })

  it('weekly: excludes warmup sets from both tonnage and set counts', async () => {
    const bearer = await loginAs('user_ins_weekly_warmup')
    await postWorkout(bearer, '2026-06-10T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 60, setType: 'warmup' },
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100, setType: 'working' },
    ])
    const res = await req(
      bearer,
      'GET',
      '/api/v1/ui/insights/volume/weekly?from=2026-06-08T00:00:00.000Z&to=2026-06-15T00:00:00.000Z',
    )
    const body = (await res.json()) as WeeklyBody
    expect(body.weeks).toHaveLength(1)
    expect(body.weeks[0]).toMatchObject({ tonnageKg: 500, sets: 1 })
  })

  it('weekly: never sees another user’s sets', async () => {
    const bearerA = await loginAs('user_ins_weekly_iso_a')
    const bearerB = await loginAs('user_ins_weekly_iso_b')
    await postWorkout(bearerA, '2026-06-10T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 100 },
    ])
    const res = await req(
      bearerB,
      'GET',
      '/api/v1/ui/insights/volume/weekly?from=2026-06-08T00:00:00.000Z&to=2026-06-15T00:00:00.000Z',
    )
    const body = (await res.json()) as WeeklyBody
    expect(body.weeks[0]).toMatchObject({ tonnageKg: 0, sets: 0 })
  })

  it('weekly: defaults to a trailing 8-week window and sets the cache header', async () => {
    const bearer = await loginAs('user_ins_weekly_defaults')
    const res = await req(bearer, 'GET', '/api/v1/ui/insights/volume/weekly')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, max-age=60')
    const body = (await res.json()) as WeeklyBody
    expect(body.weeks).toHaveLength(8)
    const spanMs = new Date(body.to).getTime() - new Date(body.from).getTime()
    expect(spanMs).toBe(8 * 7 * 24 * 60 * 60 * 1000)
  })

  it('weekly: rejects an unparseable ?from and a reversed range with 400', async () => {
    const bearer = await loginAs('user_ins_weekly_bad_query')
    const bad = await req(bearer, 'GET', '/api/v1/ui/insights/volume/weekly?from=garbage')
    expect(bad.status).toBe(400)
    const reversed = await req(
      bearer,
      'GET',
      '/api/v1/ui/insights/volume/weekly?from=2026-06-15T00:00:00.000Z&to=2026-06-01T00:00:00.000Z',
    )
    expect(reversed.status).toBe(400)
  })

  it('weekly: caps a huge window and keeps from/to describing the bins returned', async () => {
    const bearer = await loginAs('user_ins_weekly_cap')
    // A workout inside the capped window and one decades before it: the
    // old code read the whole span, so every ancient set clamped into
    // the last bin and showed as one absurd bar.
    await postWorkout(bearer, '1975-06-10T10:00:00.000Z', [
      { exerciseId: squat_ex_id, reps: 5, loadKg: 999 },
    ])
    const res = await req(
      bearer,
      'GET',
      '/api/v1/ui/insights/volume/weekly?from=1970-01-01T00:00:00.000Z&to=2026-06-15T00:00:00.000Z',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as WeeklyBody
    expect(body.weeks).toHaveLength(104)
    // `to` reports the window actually read (from + 104 weeks), not the
    // requested one, so it can't claim a span wider than the bins cover.
    expect(body.to).toBe(body.weeks[103]!.to)
    expect(new Date(body.to).getTime() - new Date(body.from).getTime()).toBe(
      104 * 7 * 24 * 60 * 60 * 1000,
    )
    // The 1975 set is outside the capped read, so no bin absorbs it.
    expect(body.weeks.every((w) => w.tonnageKg === 0)).toBe(true)
  })

  // Pins the envelope contract for the two uncapped shapes. Neither is
  // a regression guard for the cap fix (the capped test above is) —
  // they document what `from`/`to` mean relative to the bins, so a
  // future change to the rounding can't drift silently.
  it('weekly: envelope tracks the bins on an aligned window, the request on a partial one', async () => {
    const bearer = await loginAs('user_ins_weekly_envelope')

    // Exact multiple of a week: the bins land exactly on the request.
    const aligned = await req(
      bearer,
      'GET',
      '/api/v1/ui/insights/volume/weekly?from=2026-06-08T00:00:00.000Z&to=2026-06-29T00:00:00.000Z',
    )
    const alignedBody = (await aligned.json()) as WeeklyBody
    expect(alignedBody.weeks).toHaveLength(3)
    expect(alignedBody.from).toBe(alignedBody.weeks[0]!.from)
    expect(alignedBody.to).toBe(alignedBody.weeks[2]!.to)

    // Partial span (2.5 weeks): the bin count rounds up, so the last
    // bin runs past the requested `to`, which is still what's reported
    // — the read really did stop there. Only the shipped client's
    // week-aligned ranges are exercised in the UI; this pins the
    // fallback rather than leaving it to chance.
    const partial = await req(
      bearer,
      'GET',
      '/api/v1/ui/insights/volume/weekly?from=2026-06-08T00:00:00.000Z&to=2026-06-25T12:00:00.000Z',
    )
    const partialBody = (await partial.json()) as WeeklyBody
    expect(partialBody.weeks).toHaveLength(3)
    expect(partialBody.to).toBe('2026-06-25T12:00:00.000Z')
    expect(new Date(partialBody.weeks[2]!.to).getTime()).toBeGreaterThan(
      new Date(partialBody.to).getTime(),
    )
  })
})
