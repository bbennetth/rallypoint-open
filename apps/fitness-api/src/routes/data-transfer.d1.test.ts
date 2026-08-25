import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import type { R2Bucket } from '@cloudflare/workers-types'
import { unzipSync, zipSync } from 'fflate'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { createBindingObjectStore } from '@rallypoint/object-store'
import type { ImportSummary } from '@rallypoint/api-kit'
import type { FitnessManifest } from '@rallypoint/fitness-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 + R2 integration tests for the whole-account data export/import.
//
// The load-bearing assertion is the ROUNDTRIP: seed account A, export it,
// import the archive into a fresh account B, and check B ended up with the same
// data — including remapped custom exercises and real photo bytes. Then import
// the same archive a second time and check nothing duplicates, because
// "run it again" is the documented recovery path for a partial import.

type ApiErrorBody = { error: { code: string; message: string } }

const CSRF = 'csrf_token_value_transfer_aaaaaaaaaaaa'
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04])
// A real seeded catalog row (packages/fitness-db/migrations/0002_seed_catalog.sql)
// so the bulk-insert test satisfies workout_sets' NOT NULL exercise FK.
const GLOBAL_EXERCISE_ID = 'fx_seed_ab_wheel_rollout'

describe('D1 integration — data export/import', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let db: Db
  let seq = 0

  beforeAll(async () => {
    db = createDb(env.DB)
    repos = buildD1Repos(db)
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    const services: Services = {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: async () => {},
      },
      rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
      profiles: { lookup: async () => null },
      settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
      offClient: { lookup: async () => null, search: async () => [] },
      objectStore: createBindingObjectStore(env.OBJECT_STORE as R2Bucket),
    }
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

  function headers(bearer: string, contentType?: string): Record<string, string> {
    return {
      cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      origin: envVars.FITNESS_UI_ORIGIN,
      ...(contentType ? { 'content-type': contentType } : {}),
    }
  }

  /** A distinct user per test so accounts never bleed into each other. */
  function nextUser(label: string): string {
    seq++
    return `user_transfer_${label}_${seq}`
  }

  async function exportArchive(bearer: string): Promise<Uint8Array> {
    const res = await app.request('http://localhost/api/v1/ui/data-export', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    return new Uint8Array(await res.arrayBuffer())
  }

  async function importArchive(
    bearer: string,
    archive: Uint8Array,
  ): Promise<{ status: number; body: ImportSummary }> {
    const res = await app.request('http://localhost/api/v1/ui/data-import', {
      method: 'POST',
      headers: headers(bearer, 'application/zip'),
      body: archive.slice().buffer as ArrayBuffer,
    })
    return { status: res.status, body: (await res.json()) as ImportSummary }
  }

  function manifestOf(archive: Uint8Array): FitnessManifest {
    const files = unzipSync(archive)
    return JSON.parse(new TextDecoder().decode(files['manifest.json']!)) as FitnessManifest
  }

  /** Seed one account with a representative slice of every exported shape. */
  async function seedAccount(userId: string, bearer: string) {
    const exercise = await repos.exercises.createCustom({
      id: `fx_seed_${seq}`,
      name: `Seeded Lift ${seq}`,
      ownerUserId: userId,
      discipline: 'strength',
      movementPattern: 'hinge',
      metricShape: 'reps_load',
      unilateral: false,
      muscles: [],
    })

    await repos.workouts.create({
      id: `fs_seed_${seq}`,
      userId,
      performedAt: new Date('2026-03-01T10:00:00.000Z'),
      modality: 'strength',
      title: 'Seeded session',
      sets: [
        {
          id: `fset_seed_${seq}`,
          exerciseId: exercise.id,
          setIndex: 0,
          reps: 5,
          loadKg: 100,
          setType: 'working',
        },
      ],
    })

    await repos.metrics.create({
      id: `fm_seed_${seq}`,
      userId,
      recordedAt: new Date('2026-03-02T07:00:00.000Z'),
      kind: 'weight',
      value: 81.5,
      unit: 'kg',
    })

    const photo = await app.request(
      `http://localhost/api/v1/ui/progress-photos?pose=front&takenAt=${encodeURIComponent('2026-03-03T09:00:00.000Z')}`,
      { method: 'POST', headers: headers(bearer, 'image/jpeg'), body: JPEG_BYTES.slice().buffer as ArrayBuffer },
    )
    expect(photo.status).toBe(201)

    return { exercise }
  }

  it('roundtrips an account into a fresh one, remapping custom exercises', async () => {
    const source = nextUser('src')
    const sourceBearer = await loginAs(source)
    const { exercise } = await seedAccount(source, sourceBearer)

    const archive = await exportArchive(sourceBearer)
    const manifest = manifestOf(archive)
    expect(manifest.app).toBe('fitness')
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.entities.workouts).toHaveLength(1)
    // The set points at the custom exercise by its export ref, flagged owned.
    expect(manifest.entities.workouts[0]!.sets[0]!.exercise).toEqual({
      id: exercise.id,
      owned: true,
    })

    const target = nextUser('dst')
    const targetBearer = await loginAs(target)
    const { status, body } = await importArchive(targetBearer, archive)
    expect(status).toBe(200)
    expect(body.warnings).toEqual([])
    expect(body.counts['exercises']).toEqual({ created: 1, skipped: 0 })
    expect(body.counts['workouts']).toEqual({ created: 1, skipped: 0 })
    expect(body.counts['metrics']).toEqual({ created: 1, skipped: 0 })
    expect(body.counts['progressPhotos']).toEqual({ created: 1, skipped: 0 })

    // The workout landed on the target and its set points at the TARGET's own
    // copy of the exercise, not the source's row.
    const targetRows = await repos.dataTransfer.readAll(target)
    expect(targetRows.workouts).toHaveLength(1)
    expect(targetRows.workouts[0]!.performedAt.toISOString()).toBe('2026-03-01T10:00:00.000Z')
    expect(targetRows.workoutSets).toHaveLength(1)
    expect(targetRows.exercises).toHaveLength(1)
    expect(targetRows.workoutSets[0]!.exerciseId).toBe(targetRows.exercises[0]!.id)
    expect(targetRows.workoutSets[0]!.exerciseId).not.toBe(exercise.id)
    expect(targetRows.exercises[0]!.ownerUserId).toBe(target)
    expect(targetRows.metrics[0]!.value).toBe(81.5)
  })

  it('restores photo bytes, not just the row', async () => {
    const source = nextUser('psrc')
    const sourceBearer = await loginAs(source)
    await seedAccount(source, sourceBearer)

    const archive = await exportArchive(sourceBearer)
    const target = nextUser('pdst')
    const targetBearer = await loginAs(target)
    await importArchive(targetBearer, archive)

    const rows = await repos.dataTransfer.readAll(target)
    expect(rows.progressPhotos).toHaveLength(1)
    const restored = rows.progressPhotos[0]!
    expect(restored.pose).toBe('front')
    expect(restored.takenAt.toISOString()).toBe('2026-03-03T09:00:00.000Z')
    // The object key is minted for the TARGET user, so the bytes are not shared
    // with (or readable from) the source account's key.
    expect(restored.objectKey).toContain(target)

    const stored = await (env.OBJECT_STORE as R2Bucket).get(restored.objectKey)
    expect(stored).not.toBeNull()
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(JPEG_BYTES)
  })

  it('is idempotent — a second import of the same archive creates nothing', async () => {
    const source = nextUser('isrc')
    const sourceBearer = await loginAs(source)
    await seedAccount(source, sourceBearer)
    const archive = await exportArchive(sourceBearer)

    const target = nextUser('idst')
    const targetBearer = await loginAs(target)
    await importArchive(targetBearer, archive)
    const afterFirst = await repos.dataTransfer.readAll(target)

    const second = await importArchive(targetBearer, archive)
    expect(second.status).toBe(200)
    expect(second.body.counts['exercises']).toEqual({ created: 0, skipped: 1 })
    expect(second.body.counts['workouts']).toEqual({ created: 0, skipped: 1 })
    expect(second.body.counts['metrics']).toEqual({ created: 0, skipped: 1 })
    expect(second.body.counts['progressPhotos']).toEqual({ created: 0, skipped: 1 })

    const afterSecond = await repos.dataTransfer.readAll(target)
    expect(afterSecond.workouts).toHaveLength(afterFirst.workouts.length)
    expect(afterSecond.workoutSets).toHaveLength(afterFirst.workoutSets.length)
    expect(afterSecond.exercises).toHaveLength(afterFirst.exercises.length)
    expect(afterSecond.metrics).toHaveLength(afterFirst.metrics.length)
    expect(afterSecond.progressPhotos).toHaveLength(afterFirst.progressPhotos.length)
  })

  it('re-exports a restored account to an equivalent archive', async () => {
    // Export → import → export must be stable: the second archive keeps the
    // ORIGINAL refs, which is what stops a chain of restores from multiplying
    // rows across accounts.
    const source = nextUser('rsrc')
    const sourceBearer = await loginAs(source)
    await seedAccount(source, sourceBearer)
    const first = manifestOf(await exportArchive(sourceBearer))

    const target = nextUser('rdst')
    const targetBearer = await loginAs(target)
    await importArchive(targetBearer, await exportArchive(sourceBearer))
    const second = manifestOf(await exportArchive(targetBearer))

    expect(second.entities.workouts.map((w) => w.ref)).toEqual(
      first.entities.workouts.map((w) => w.ref),
    )
    expect(second.entities.exercises.map((e) => e.ref)).toEqual(
      first.entities.exercises.map((e) => e.ref),
    )
    expect(second.entities.metrics.map((m) => m.ref)).toEqual(
      first.entities.metrics.map((m) => m.ref),
    )
  })

  it('merges into an account that already has unrelated data', async () => {
    const source = nextUser('msrc')
    const sourceBearer = await loginAs(source)
    await seedAccount(source, sourceBearer)
    const archive = await exportArchive(sourceBearer)

    const target = nextUser('mdst')
    const targetBearer = await loginAs(target)
    await seedAccount(target, targetBearer) // the target's own pre-existing data

    const before = await repos.dataTransfer.readAll(target)
    const { body } = await importArchive(targetBearer, archive)
    expect(body.counts['workouts']).toEqual({ created: 1, skipped: 0 })

    const after = await repos.dataTransfer.readAll(target)
    expect(after.workouts).toHaveLength(before.workouts.length + 1)
    // Nothing the target already owned was touched.
    const keptIds = new Set(after.workouts.map((w) => w.id))
    for (const w of before.workouts) expect(keptIds.has(w.id)).toBe(true)
  })

  it('drops a set whose global exercise has vanished, keeping the workout', async () => {
    const source = nextUser('gsrc')
    const sourceBearer = await loginAs(source)
    await seedAccount(source, sourceBearer)
    const archive = await exportArchive(sourceBearer)

    // Rewrite the archive so the set points at a GLOBAL exercise id that does
    // not exist — the shape you get when a curated catalog row is retired
    // between export and import.
    const files = unzipSync(archive)
    const manifest = manifestOf(archive)
    manifest.entities.exercises = []
    manifest.entities.workouts[0]!.sets[0]!.exercise = { id: 'fx_retired_global', owned: false }
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
    const rewritten = zipSync(files)

    const target = nextUser('gdst')
    const targetBearer = await loginAs(target)
    const { status, body } = await importArchive(targetBearer, rewritten)
    expect(status).toBe(200)
    expect(body.counts['workouts']).toEqual({ created: 1, skipped: 0 })
    expect(body.warnings).toContainEqual(
      expect.objectContaining({ entity: 'workouts', code: 'missing_exercise' }),
    )

    const rows = await repos.dataTransfer.readAll(target)
    expect(rows.workouts).toHaveLength(1)
    expect(rows.workoutSets).toHaveLength(0)
  })

  it('rejects an archive whose manifest is not the first entry', async () => {
    const source = nextUser('osrc')
    const sourceBearer = await loginAs(source)
    await seedAccount(source, sourceBearer)
    const files = unzipSync(await exportArchive(sourceBearer))

    // zipSync writes entries in key order, so putting a blob first is enough.
    const reordered = zipSync({
      'blobs/stray.jpg': JPEG_BYTES,
      'manifest.json': files['manifest.json']!,
    })

    const target = nextUser('odst')
    const targetBearer = await loginAs(target)
    const { status, body } = await importArchive(targetBearer, reordered)
    expect(status).toBe(400)
    expect((body as unknown as ApiErrorBody).error.code).toBe('manifest_not_first')

    // Nothing was written before the rejection.
    const rows = await repos.dataTransfer.readAll(target)
    expect(rows.workouts).toHaveLength(0)
  })

  it('rejects a body that is not a zip at all', async () => {
    const target = nextUser('jdst')
    const targetBearer = await loginAs(target)
    const { status, body } = await importArchive(
      targetBearer,
      new TextEncoder().encode('not a zip file'),
    )
    expect(status).toBe(400)
    expect((body as unknown as ApiErrorBody).error.code).toBe('zip_invalid')
  })

  it('rejects a manifest with the wrong schema version', async () => {
    const bad = zipSync({
      'manifest.json': new TextEncoder().encode(
        JSON.stringify({ schemaVersion: 99, app: 'fitness', exportedAt: 0, entities: {} }),
      ),
    })
    const target = nextUser('vdst')
    const targetBearer = await loginAs(target)
    const { status } = await importArchive(targetBearer, bad)
    expect(status).toBe(400)
  })

  it('rolls a parent back when its children fail, so a retry can still restore it', async () => {
    // The recovery story ("just run it again") only holds if a parent can
    // never land without its children: the planner treats an existing parent
    // ref as "this subtree is already here" and skips its children, so a
    // half-written subtree would be stranded forever and reported as a clean
    // skip. insertAll therefore writes each parent+children group in one
    // db.batch, which D1 runs as a single transaction.
    const user = nextUser('atomic')

    const workoutId = `fs_atomic_${seq}`
    await expect(
      repos.dataTransfer.insertAll({
        exercises: [],
        exerciseMuscles: [],
        foodItems: [],
        metrics: [],
        workouts: [
          {
            id: workoutId,
            userId: user,
            performedAt: new Date('2026-04-01T10:00:00.000Z'),
            modality: 'strength',
            title: 'Should roll back',
            durationS: null,
            location: null,
            rpe: null,
            notes: null,
            payload: null,
            ref: 'ref_atomic',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        // exercise_id is NOT NULL with a real FK, so this set cannot insert.
        workoutSets: [
          {
            id: `fset_atomic_${seq}`,
            workoutId,
            exerciseId: 'fx_does_not_exist_anywhere',
            setIndex: 0,
            reps: 5,
            loadKg: 100,
            calories: null,
            distanceM: null,
            timeS: null,
            inclinePct: null,
            rounds: null,
            rpe: null,
            notes: null,
            setType: 'working',
          },
        ],
        wodTemplates: [],
        trainingPlans: [],
        trainingPlanItems: [],
        recipes: [],
        recipeIngredients: [],
        preparedMeals: [],
        preparedMealIngredients: [],
        foodLogEntries: [],
        foodFavorites: [],
        exerciseFavorites: [],
        machineSettings: [],
      }),
    ).rejects.toThrow()

    // The workout must NOT be there — otherwise a retry would skip it by ref
    // and its sets would never arrive.
    const rows = await repos.dataTransfer.readAll(user)
    expect(rows.workouts).toHaveLength(0)
    expect(rows.workoutSets).toHaveLength(0)
  })

  it('imports a large workout history without exceeding D1 batch limits', async () => {
    // Guards the OTHER failure mode of the atomic-subtree write: batching a
    // whole entity group at once would build thousands of statements and be
    // rejected wholesale, and the retry would rebuild the same oversized batch
    // — permanently blocking a big account's restore. Batches are packed under
    // the statement ceiling instead, without splitting a parent from its sets.
    const user = nextUser('scale')
    const workoutCount = 120
    const setsPer = 6

    const bulk = {
      exercises: [],
      exerciseMuscles: [],
      foodItems: [],
      metrics: [],
      workouts: Array.from({ length: workoutCount }, (_, i) => ({
        id: `fs_scale_${seq}_${i}`,
        userId: user,
        performedAt: new Date(Date.UTC(2026, 0, 1 + (i % 28), 10)),
        modality: 'strength',
        title: `Session ${i}`,
        durationS: null,
        location: null,
        rpe: null,
        notes: null,
        payload: null,
        ref: `ref_scale_${i}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      workoutSets: Array.from({ length: workoutCount * setsPer }, (_, n) => ({
        id: `fset_scale_${seq}_${n}`,
        workoutId: `fs_scale_${seq}_${Math.floor(n / setsPer)}`,
        exerciseId: GLOBAL_EXERCISE_ID,
        setIndex: n % setsPer,
        reps: 5,
        loadKg: 100,
        calories: null,
        distanceM: null,
        timeS: null,
        inclinePct: null,
        rounds: null,
        rpe: null,
        notes: null,
        setType: 'working',
      })),
      wodTemplates: [],
      trainingPlans: [],
      trainingPlanItems: [],
      recipes: [],
      recipeIngredients: [],
      preparedMeals: [],
      preparedMealIngredients: [],
      foodLogEntries: [],
      foodFavorites: [],
      exerciseFavorites: [],
      machineSettings: [],
    }

    await repos.dataTransfer.insertAll(bulk)

    const rows = await repos.dataTransfer.readAll(user)
    expect(rows.workouts).toHaveLength(workoutCount)
    expect(rows.workoutSets).toHaveLength(workoutCount * setsPer)
    // Every set landed with its own workout — no subtree split across batches.
    const byWorkout = new Map<string, number>()
    for (const s of rows.workoutSets) {
      byWorkout.set(s.workoutId, (byWorkout.get(s.workoutId) ?? 0) + 1)
    }
    expect(byWorkout.size).toBe(workoutCount)
    for (const count of byWorkout.values()) expect(count).toBe(setsPer)
  })

  it('requires a session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/data-export')
    expect(res.status).toBe(401)
  })

  it('never exports another account\'s rows', async () => {
    const a = nextUser('iso1')
    const aBearer = await loginAs(a)
    await seedAccount(a, aBearer)

    const b = nextUser('iso2')
    const bBearer = await loginAs(b)
    const manifest = manifestOf(await exportArchive(bBearer))
    expect(manifest.entities.workouts).toEqual([])
    expect(manifest.entities.exercises).toEqual([])
    expect(manifest.entities.progressPhotos).toEqual([])
  })
})
