import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { ExerciseRecord, Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import {
  approveSubmission,
  rejectSubmission,
  SubmissionNotFoundError,
  SubmissionNotPendingError,
} from '../services/submission-review.js'
import { createSubmissionScanService } from '../services/submission-ai-scan.js'

// Exercise submissions — a user promoting a private custom exercise into
// the curated global catalog for admin review, with an optional
// history-migration step once approved. Covers the submit happy path +
// guards (no primary muscle, not-owned, double-pending), the actor's own
// list, the admin approve/reject service, the accept/decline migration
// batch (workout_sets/favorites/machine-settings re-pointed, custom row
// deleted), and cross-user authorization on /migrate.

const CSRF = 'csrf_token_value_submissions_aaaaaaaaaaaaaaaaa'

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

describe('D1 integration — exercise submissions', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let _db: Db

  beforeAll(() => {
    _db = createDb(env.DB)
    repos = buildD1Repos(_db)
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
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  let counter = 0
  function nextId(): string {
    counter += 1
    return `${Date.now()}_${counter}`
  }

  async function makeCustomExercise(
    userId: string,
    opts?: { withPrimaryMuscle?: boolean; name?: string },
  ): Promise<ExerciseRecord> {
    const withPrimary = opts?.withPrimaryMuscle ?? true
    return repos.exercises.createCustom({
      id: `fx_test_${nextId()}`,
      ownerUserId: userId,
      name: opts?.name ?? `Test Exercise ${nextId()}`,
      discipline: 'dumbbell',
      movementPattern: 'horizontal_pull',
      metricShape: 'load_reps',
      unilateral: false,
      muscles: withPrimary ? [{ muscleId: 'lats', role: 'primary' }] : [],
    })
  }

  const SEED_EX_ID = 'fx_seed_pull_up'

  it('submits a custom exercise with a primary muscle', async () => {
    const bearer = await loginAs('user_sub_happy')
    const ex = await makeCustomExercise('user_sub_happy')

    const res = await req(bearer, 'POST', `/api/v1/ui/exercises/${ex.id}/submit`)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; exerciseId: string; status: string }
    expect(body.exerciseId).toBe(ex.id)
    expect(body.status).toBe('pending')
  })

  it('rejects submitting an exercise with no primary-role muscle', async () => {
    const bearer = await loginAs('user_sub_no_primary')
    const ex = await makeCustomExercise('user_sub_no_primary', { withPrimaryMuscle: false })

    const res = await req(bearer, 'POST', `/api/v1/ui/exercises/${ex.id}/submit`)
    expect(res.status).toBe(400)
  })

  it('404s when the exercise is not owned by the actor (global)', async () => {
    const bearer = await loginAs('user_sub_global')
    const res = await req(bearer, 'POST', `/api/v1/ui/exercises/${SEED_EX_ID}/submit`)
    expect(res.status).toBe(404)
  })

  it("404s when the exercise belongs to another user", async () => {
    const owner = await loginAs('user_sub_owner')
    const other = await loginAs('user_sub_other')
    const ex = await makeCustomExercise('user_sub_owner')
    // sanity: owner can see it
    expect((await req(owner, 'GET', `/api/v1/ui/exercises/${ex.id}`)).status).toBe(200)

    const res = await req(other, 'POST', `/api/v1/ui/exercises/${ex.id}/submit`)
    expect(res.status).toBe(404)
  })

  it('blocks a second pending submission for the same exercise', async () => {
    const bearer = await loginAs('user_sub_double')
    const ex = await makeCustomExercise('user_sub_double')

    const first = await req(bearer, 'POST', `/api/v1/ui/exercises/${ex.id}/submit`)
    expect(first.status).toBe(201)

    const second = await req(bearer, 'POST', `/api/v1/ui/exercises/${ex.id}/submit`)
    expect(second.status).toBe(409)
  })

  it("lists the actor's own submissions, newest first", async () => {
    const bearer = await loginAs('user_sub_list')
    const ex1 = await makeCustomExercise('user_sub_list', { name: 'List Ex One' })
    const ex2 = await makeCustomExercise('user_sub_list', { name: 'List Ex Two' })
    await req(bearer, 'POST', `/api/v1/ui/exercises/${ex1.id}/submit`)
    await req(bearer, 'POST', `/api/v1/ui/exercises/${ex2.id}/submit`)

    const res = await req(bearer, 'GET', '/api/v1/ui/submissions')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { submissions: { exerciseId: string }[] }
    expect(body.submissions).toHaveLength(2)
    expect(body.submissions.map((s) => s.exerciseId).sort()).toEqual(
      [ex1.id, ex2.id].sort(),
    )
  })

  it('approve via the admin service sets status approved + migration offered', async () => {
    const userId = 'user_sub_approve'
    const ex = await makeCustomExercise(userId, { name: 'Approve Me Exercise' })
    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })

    const approved = await approveSubmission(repos, submission.id)
    expect(approved.status).toBe('approved')
    expect(approved.migrationStatus).toBe('offered')
    expect(approved.globalExerciseId).toBeTruthy()

    const globalEx = await repos.exercises.getForActor(userId, approved.globalExerciseId!)
    expect(globalEx?.ownerUserId).toBeNull()
    expect(globalEx?.name).toBe('Approve Me Exercise')
  })

  it('reject with an admin note persists the note', async () => {
    const userId = 'user_sub_reject'
    const ex = await makeCustomExercise(userId, { name: 'Reject Me Exercise' })
    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })

    const rejected = await rejectSubmission(repos, submission.id, {
      note: 'Too similar to an existing movement.',
    })
    expect(rejected.status).toBe('rejected')
    expect(rejected.adminNote).toBe('Too similar to an existing movement.')
    expect(rejected.migrationStatus).toBe('none')
  })

  it(
    'approve when a same-name global exercise already exists links to it ' +
      'instead of creating a duplicate',
    async () => {
      // Two different users each submit a custom exercise whose names
      // collide case-insensitively (the dedup check, like the DB's own
      // global-name unique index, compares on lower(name); fixtures go
      // straight through the repo here, bypassing the create-custom
      // route's extra whitespace normalization, so only case is varied).
      // Approving the first creates the global row; approving the second
      // must LINK to that same row, not mint a second one.
      const userA = 'user_sub_dupe_a'
      const userB = 'user_sub_dupe_b'
      const exA = await makeCustomExercise(userA, { name: 'Reverse Nordic Curl' })
      const exB = await makeCustomExercise(userB, { name: 'REVERSE NORDIC CURL' })

      const subA = await repos.submissions.create({
        id: `fsub_test_${nextId()}`,
        exerciseId: exA.id,
        userId: userA,
      })
      const subB = await repos.submissions.create({
        id: `fsub_test_${nextId()}`,
        exerciseId: exB.id,
        userId: userB,
      })

      const approvedA = await approveSubmission(repos, subA.id)
      const approvedB = await approveSubmission(repos, subB.id)

      expect(approvedA.globalExerciseId).toBeTruthy()
      expect(approvedB.globalExerciseId).toBe(approvedA.globalExerciseId)
    },
  )

  it('accept migration re-points sets/favorites/machine-settings and deletes the custom row', async () => {
    const userId = 'user_sub_migrate_accept'
    const ex = await makeCustomExercise(userId, { name: 'Migrate Accept Exercise' })

    // Give the custom exercise some history: a logged set, a favorite,
    // and machine settings.
    const workout = await repos.workouts.create({
      id: `fs_test_${nextId()}`,
      userId,
      performedAt: new Date(),
      modality: 'strength',
      sets: [
        {
          id: `fset_test_${nextId()}`,
          exerciseId: ex.id,
          setIndex: 0,
          reps: 8,
          loadKg: 40,
        },
      ],
    })
    await repos.exerciseFavorites.add(userId, ex.id)
    await repos.machineSettings.put(userId, ex.id, [{ name: 'Cable height', value: '4' }])
    // ... and an exercise-sourced training-plan item (sourceKind='exercise').
    const plan = await repos.trainingPlans.create({
      id: `fpl_test_${nextId()}`,
      ownerUserId: userId,
      name: 'Migrate Accept Plan',
    })
    const planItem = await repos.trainingPlans.addItem({
      id: `fpli_test_${nextId()}`,
      planId: plan.id,
      dayKey: 'mon',
      position: 0,
      sourceKind: 'exercise',
      sourceId: ex.id,
    })

    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })
    const approved = await approveSubmission(repos, submission.id)
    const globalId = approved.globalExerciseId!

    const bearer = await loginAs(userId)
    const res = await req(bearer, 'POST', `/api/v1/ui/submissions/${submission.id}/migrate`, {
      accept: true,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { migrationStatus: string }
    expect(body.migrationStatus).toBe('accepted')

    // workout_sets re-pointed
    const reloadedWorkout = await repos.workouts.getForActor(userId, workout.id)
    expect(reloadedWorkout?.sets[0]?.exerciseId).toBe(globalId)

    // favorites re-pointed
    const favIds = await repos.exerciseFavorites.listForActor(userId)
    expect(favIds).toContain(globalId)
    expect(favIds).not.toContain(ex.id)

    // machine settings re-pointed
    const globalSettings = await repos.machineSettings.get(userId, globalId)
    expect(globalSettings).toEqual([{ name: 'Cable height', value: '4' }])
    const customSettings = await repos.machineSettings.get(userId, ex.id)
    expect(customSettings).toEqual([])

    // training-plan item re-pointed
    const reloadedItem = await repos.trainingPlans.getItem(plan.id, planItem.id)
    expect(reloadedItem?.sourceId).toBe(globalId)

    // custom exercise + its muscle maps are gone
    const customStillVisible = await repos.exercises.getForActor(userId, ex.id)
    expect(customStillVisible).toBeNull()

    const finalSubmission = await repos.submissions.getById(submission.id)
    expect(finalSubmission?.migrationStatus).toBe('accepted')
    expect(finalSubmission?.migratedAt).toBeInstanceOf(Date)
  })

  it("accept migration rewrites the user's template bodies", async () => {
    const userId = 'user_sub_migrate_templates'
    const ex = await makeCustomExercise(userId, { name: 'Migrate Template Exercise' })
    const otherEx = await makeCustomExercise(userId, { name: 'Unrelated Exercise' })

    const strengthTemplate = await repos.wodTemplates.createCustom({
      id: `wt_test_${nextId()}`,
      name: 'Rewrite Strength Template',
      ownerUserId: userId,
      kind: 'strength',
      description: null,
      body: {
        kind: 'strength',
        blocks: [
          {
            exerciseId: ex.id,
            name: 'Migrate Template Exercise',
            sets: [{ reps: 5, loadKg: 40 }],
          },
          {
            exerciseId: otherEx.id,
            name: 'Unrelated Exercise',
            sets: [{ reps: 10, loadKg: 20 }],
          },
        ],
      },
    })

    const wodTemplate = await repos.wodTemplates.createCustom({
      id: `wt_test_${nextId()}`,
      name: 'Rewrite WOD Template',
      ownerUserId: userId,
      kind: 'wod',
      wodType: 'for_time',
      timeCapS: 1200,
      description: null,
      body: {
        wodType: 'for_time',
        rounds: 1,
        movements: [
          { exerciseId: ex.id, reps: 21 },
          { exerciseId: otherEx.id, reps: 15 },
        ],
        perMinuteBuyIn: { exerciseId: ex.id, reps: 5 },
      },
    })

    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })
    const approved = await approveSubmission(repos, submission.id)
    const globalId = approved.globalExerciseId!

    const bearer = await loginAs(userId)
    const beforeStrength = await repos.wodTemplates.getForActor(userId, strengthTemplate.id)
    const beforeWod = await repos.wodTemplates.getForActor(userId, wodTemplate.id)
    const res = await req(bearer, 'POST', `/api/v1/ui/submissions/${submission.id}/migrate`, {
      accept: true,
    })
    expect(res.status).toBe(200)

    const afterStrength = await repos.wodTemplates.getForActor(userId, strengthTemplate.id)
    expect(afterStrength?.kind).toBe('strength')
    if (afterStrength?.kind === 'strength') {
      expect(afterStrength.body.blocks[0]?.exerciseId).toBe(globalId)
      expect(afterStrength.body.blocks[1]?.exerciseId).toBe(otherEx.id)
    }
    expect(afterStrength!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      beforeStrength!.updatedAt.getTime(),
    )

    const afterWod = await repos.wodTemplates.getForActor(userId, wodTemplate.id)
    expect(afterWod?.kind).toBe('wod')
    if (afterWod?.kind === 'wod') {
      expect(afterWod.body.movements[0]?.exerciseId).toBe(globalId)
      expect(afterWod.body.movements[1]?.exerciseId).toBe(otherEx.id)
      expect(afterWod.body.perMinuteBuyIn?.exerciseId).toBe(globalId)
    }
    expect(afterWod!.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeWod!.updatedAt.getTime())

    // End-to-end proof: a workout logged against the REWRITTEN (global) id
    // no longer 400s at the visibility check (routes/workouts.ts) — this is
    // the user-visible bug: before the fix the template still pointed at
    // the deleted custom exercise.
    const workoutRes = await req(bearer, 'POST', '/api/v1/ui/workouts', {
      performedAt: new Date().toISOString(),
      modality: 'strength',
      sets: [{ id: `fset_test_${nextId()}`, exerciseId: globalId, setIndex: 0, reps: 5, loadKg: 40 }],
    })
    expect(workoutRes.status).toBe(201)
  })

  it("accept migration leaves other users' templates untouched", async () => {
    const userId = 'user_sub_migrate_isolated'
    const otherUserId = 'user_sub_migrate_isolated_other'
    const ex = await makeCustomExercise(userId, { name: 'Isolated Migrate Exercise' })

    // Another user's template happens to reference the SAME custom
    // exercise id string (impossible for a real custom exercise since ids
    // are per-owner, but this proves the ownerUserId scoping on the
    // rewrite UPDATE, not just accidental non-collision).
    const otherTemplate = await repos.wodTemplates.createCustom({
      id: `wt_test_${nextId()}`,
      name: 'Other User Template',
      ownerUserId: otherUserId,
      kind: 'strength',
      description: null,
      body: {
        kind: 'strength',
        blocks: [{ exerciseId: ex.id, name: 'Isolated Migrate Exercise', sets: [{ reps: 5, loadKg: 40 }] }],
      },
    })
    const beforeBody = JSON.stringify(otherTemplate.body)

    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })
    await approveSubmission(repos, submission.id)

    const bearer = await loginAs(userId)
    const res = await req(bearer, 'POST', `/api/v1/ui/submissions/${submission.id}/migrate`, {
      accept: true,
    })
    expect(res.status).toBe(200)

    const afterOtherTemplate = await repos.wodTemplates.getForActor(otherUserId, otherTemplate.id)
    expect(JSON.stringify(afterOtherTemplate?.body)).toBe(beforeBody)
  })

  it('admin + user lists still show the exercise snapshot after an accepted migration', async () => {
    const userId = 'user_sub_snapshot'
    const ex = await makeCustomExercise(userId, { name: 'Snapshot Survives Exercise' })
    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })
    await approveSubmission(repos, submission.id)

    const bearer = await loginAs(userId)
    const res = await req(bearer, 'POST', `/api/v1/ui/submissions/${submission.id}/migrate`, {
      accept: true,
    })
    expect(res.status).toBe(200)
    // The private custom row is now deleted — the snapshot must resolve
    // through globalExerciseId instead of rendering blank.
    expect(await repos.exercises.getForActor(userId, ex.id)).toBeNull()

    const adminList = await repos.submissions.listByStatus('approved')
    const adminRow = adminList.find((s) => s.id === submission.id)
    expect(adminRow?.exercise.name).toBe('Snapshot Survives Exercise')
    expect(adminRow?.exercise.discipline).toBe('dumbbell')
    expect(adminRow?.exercise.muscles.map((m) => m.muscleId)).toContain('lats')

    const adminOne = await repos.submissions.getAdminById(submission.id)
    expect(adminOne?.exercise.name).toBe('Snapshot Survives Exercise')

    const userList = await repos.submissions.listByUser(userId)
    const userRow = userList.find((s) => s.id === submission.id)
    expect(userRow?.exerciseName).toBe('Snapshot Survives Exercise')
  })

  it('acceptMigration after a committed decline is a full no-op (TOCTOU guard)', async () => {
    const userId = 'user_sub_migrate_toctou'
    const ex = await makeCustomExercise(userId, { name: 'Migrate TOCTOU Exercise' })
    const workout = await repos.workouts.create({
      id: `fs_test_${nextId()}`,
      userId,
      performedAt: new Date(),
      modality: 'strength',
      sets: [{ id: `fset_test_${nextId()}`, exerciseId: ex.id, setIndex: 0, reps: 5 }],
    })
    await repos.exerciseFavorites.add(userId, ex.id)
    await repos.machineSettings.put(userId, ex.id, [{ name: 'Seat', value: '2' }])
    const template = await repos.wodTemplates.createCustom({
      id: `wt_test_${nextId()}`,
      name: 'TOCTOU Template',
      ownerUserId: userId,
      kind: 'strength',
      description: null,
      body: {
        kind: 'strength',
        blocks: [{ exerciseId: ex.id, name: 'Migrate TOCTOU Exercise', sets: [{ reps: 5, loadKg: 40 }] }],
      },
    })
    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })
    const approved = await approveSubmission(repos, submission.id)
    await repos.submissions.declineMigration(submission.id)

    // The repo-level accept (as a raced request would issue after its own
    // stale pre-check) must no-op on every table via the EXISTS guards.
    const result = await repos.submissions.acceptMigration({
      submissionId: submission.id,
      userId,
      customExerciseId: ex.id,
      globalExerciseId: approved.globalExerciseId!,
    })
    expect(result?.migrationStatus).toBe('declined')

    const reloadedWorkout = await repos.workouts.getForActor(userId, workout.id)
    expect(reloadedWorkout?.sets[0]?.exerciseId).toBe(ex.id)
    const favIds = await repos.exerciseFavorites.listForActor(userId)
    expect(favIds).toContain(ex.id)
    expect(favIds).not.toContain(approved.globalExerciseId)
    expect(await repos.machineSettings.get(userId, ex.id)).toEqual([
      { name: 'Seat', value: '2' },
    ])
    expect(await repos.machineSettings.get(userId, approved.globalExerciseId!)).toEqual([])
    expect(await repos.exercises.getForActor(userId, ex.id)).not.toBeNull()

    const reloadedTemplate = await repos.wodTemplates.getForActor(userId, template.id)
    expect(reloadedTemplate?.kind).toBe('strength')
    if (reloadedTemplate?.kind === 'strength') {
      expect(reloadedTemplate.body.blocks[0]?.exerciseId).toBe(ex.id)
    }
  })

  it('decline migration leaves the custom exercise intact', async () => {
    const userId = 'user_sub_migrate_decline'
    const ex = await makeCustomExercise(userId, { name: 'Migrate Decline Exercise' })
    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })
    await approveSubmission(repos, submission.id)

    const bearer = await loginAs(userId)
    const res = await req(bearer, 'POST', `/api/v1/ui/submissions/${submission.id}/migrate`, {
      accept: false,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { migrationStatus: string }
    expect(body.migrationStatus).toBe('declined')

    const stillCustom = await repos.exercises.getForActor(userId, ex.id)
    expect(stillCustom).not.toBeNull()
  })

  it('approve of an already-reviewed submission throws SubmissionNotPendingError', async () => {
    const userId = 'user_sub_double_approve'
    const ex = await makeCustomExercise(userId, { name: 'Double Approve Exercise' })
    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })
    await approveSubmission(repos, submission.id)

    await expect(approveSubmission(repos, submission.id)).rejects.toBeInstanceOf(
      SubmissionNotPendingError,
    )
    await expect(rejectSubmission(repos, submission.id)).rejects.toBeInstanceOf(
      SubmissionNotPendingError,
    )
    await expect(approveSubmission(repos, 'fsub_does_not_exist')).rejects.toBeInstanceOf(
      SubmissionNotFoundError,
    )
  })

  it('decline racing an already-accepted migration does not clobber accepted', async () => {
    const userId = 'user_sub_decline_race'
    const ex = await makeCustomExercise(userId, { name: 'Decline Race Exercise' })
    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })
    const approved = await approveSubmission(repos, submission.id)
    await repos.submissions.acceptMigration({
      submissionId: submission.id,
      userId,
      customExerciseId: ex.id,
      globalExerciseId: approved.globalExerciseId!,
    })

    // A stale decline arriving after the accept must be a no-op on
    // migrationStatus (guarded UPDATE, not last-write-wins).
    const afterDecline = await repos.submissions.declineMigration(submission.id)
    expect(afterDecline?.migrationStatus).toBe('accepted')

    // And the route surfaces the lost race as a conflict, not a fake 200.
    const bearer = await loginAs(userId)
    const res = await req(bearer, 'POST', `/api/v1/ui/submissions/${submission.id}/migrate`, {
      accept: false,
    })
    expect(res.status).toBe(409)
  })

  it('migrate is 404 for a caller who is not the original submitter', async () => {
    const userId = 'user_sub_migrate_owner'
    const intruder = 'user_sub_migrate_intruder'
    const ex = await makeCustomExercise(userId, { name: 'Migrate Owner Exercise' })
    const submission = await repos.submissions.create({
      id: `fsub_test_${nextId()}`,
      exerciseId: ex.id,
      userId,
    })
    await approveSubmission(repos, submission.id)

    const intruderBearer = await loginAs(intruder)
    const res = await req(
      intruderBearer,
      'POST',
      `/api/v1/ui/submissions/${submission.id}/migrate`,
      { accept: true },
    )
    expect(res.status).toBe(404)
  })
})

// Fire-on-write AI triage: submitting an exercise fires a scan through
// services.submissionScans without ever blocking or failing the 201 —
// including when the model call itself blows up. Uses a real
// createSubmissionScanService over a stubbed AI binding; without an
// execution context the fire path runs detached, so assertions poll.
describe('D1 integration — submit fires the AI triage scan', () => {
  let repos: Repos
  let envVars: Env

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  })

  function appWithAi(run: () => Promise<unknown>): Hono<HonoApp> {
    const ai = { run: async () => ({ response: await run() }) }
    return buildApp({
      env: envVars,
      logger: undefined,
      repos,
      services: { ...services, submissionScans: createSubmissionScanService(ai, undefined) },
    })
  }

  async function submit(app: Hono<HonoApp>, userId: string): Promise<string> {
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
    const ex = await repos.exercises.createCustom({
      id: `fx_scanfire_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: userId,
      name: `Scanfire ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`,
      discipline: 'dumbbell',
      movementPattern: 'horizontal_pull',
      metricShape: 'load_reps',
      unilateral: false,
      muscles: [{ muscleId: 'lats', role: 'primary' }],
    })
    const res = await app.request(`http://localhost/api/v1/ui/exercises/${ex.id}/submit`, {
      method: 'POST',
      headers: {
        cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${rawBearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
        'content-type': 'application/json',
        origin: envVars.FITNESS_UI_ORIGIN,
      },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    return body.id
  }

  it('lands a done scan row after a successful submit', async () => {
    const app = appWithAi(async () => ({
      findings: [{ dimension: 'quality', severity: 'info', message: 'Looks fine.' }],
    }))
    const subId = await submit(app, 'user_scanfire_ok')
    await vi.waitFor(async () => {
      const scan = await repos.submissionAiScans.getLatestBySubject('exercise', subId)
      expect(scan?.status).toBe('done')
      expect(scan?.verdict).toBe('ok')
    })
  })

  it('still 201s and lands a failed scan row when the model call throws', async () => {
    const app = appWithAi(async () => {
      throw new Error('model exploded')
    })
    const subId = await submit(app, 'user_scanfire_err')
    await vi.waitFor(async () => {
      const scan = await repos.submissionAiScans.getLatestBySubject('exercise', subId)
      expect(scan?.status).toBe('failed')
    })
  })
})
