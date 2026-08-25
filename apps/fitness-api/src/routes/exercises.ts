import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  createCustomExerciseSchema,
  disciplineSchema,
  groupExerciseHistory,
  movementPatternSchema,
  MUSCLE_GROUP_IDS,
  MUSCLE_IDS,
  normalizeExerciseName,
  patchCustomExerciseSchema,
  type ExerciseDto,
} from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import type { ExerciseFilter, ExerciseRecord } from '../repos/types.js'
import { idempotentCreate } from '../lib/idempotent-create.js'
import { readJsonBody } from './_body.js'

// The exercise catalog UI surface (cookie + CSRF + session gated in
// build-app). Reads return the union of curated global rows and the actor's
// own custom rows; the write path creates a PRIVATE custom exercise via a
// race-safe find-or-create scoped to the owner (mirrors the events
// `artists` global-catalog route, extended for the global-vs-custom split).

function toDto(r: ExerciseRecord): ExerciseDto {
  return {
    id: r.id,
    name: r.name,
    isCustom: r.ownerUserId !== null,
    discipline: r.discipline as ExerciseDto['discipline'],
    movementPattern: r.movementPattern as ExerciseDto['movementPattern'],
    metricShape: r.metricShape as ExerciseDto['metricShape'],
    unilateral: r.unilateral,
    muscles: r.muscles.map((m) => ({
      muscleId: m.muscleId,
      role: m.role as ExerciseDto['muscles'][number]['role'],
    })),
    ref: r.ref,
  }
}

export const exercisesRoutes = new Hono<HonoApp>()
  // --- list / search -------------------------------------------------
  .get('/api/v1/ui/exercises', async (c) => {
    const userId = c.var.session!.userId
    const url = new URL(c.req.url)
    // Build the filter with only the params that were actually supplied
    // (exactOptionalPropertyTypes rejects explicit `undefined`). Enum
    // filters are validated against the same vocabularies the POST path
    // uses so a typo (`?discipline=barbel`) returns 400, not silently [].
    const filter: ExerciseFilter = {}
    const q = url.searchParams.get('q')
    const discipline = url.searchParams.get('discipline')
    const group = url.searchParams.get('group')
    const muscle = url.searchParams.get('muscle')
    const pattern = url.searchParams.get('pattern')
    if (q) filter.q = q
    if (discipline) {
      const parsed = disciplineSchema.safeParse(discipline)
      if (!parsed.success) {
        throw errors.validation({
          issues: [
            { code: 'custom', path: ['discipline'], message: 'Unknown discipline.' },
          ],
        })
      }
      filter.discipline = parsed.data
    }
    if (group) {
      if (!MUSCLE_GROUP_IDS.has(group)) {
        throw errors.validation({
          issues: [
            { code: 'custom', path: ['group'], message: 'Unknown muscle group.' },
          ],
        })
      }
      filter.groupId = group
    }
    if (muscle) {
      if (!MUSCLE_IDS.has(muscle)) {
        throw errors.validation({
          issues: [
            { code: 'custom', path: ['muscle'], message: 'Unknown muscle.' },
          ],
        })
      }
      filter.muscleId = muscle
    }
    if (pattern) {
      const parsed = movementPatternSchema.safeParse(pattern)
      if (!parsed.success) {
        throw errors.validation({
          issues: [
            { code: 'custom', path: ['pattern'], message: 'Unknown movement pattern.' },
          ],
        })
      }
      filter.movementPattern = parsed.data
    }
    // The catalog is intentionally returned in full (no LIMIT): the global
    // set is ~150 rows and growing slowly, and a per-user custom set is
    // expected to stay in the low double digits. Revisit (cursor/pagination)
    // once any user crosses ~500 custom exercises.
    const rows = await c.var.repos.exercises.listForActor(userId, filter)
    return c.json({ exercises: rows.map(toDto) })
  })
  // --- get one -------------------------------------------------------
  .get('/api/v1/ui/exercises/:id', async (c) => {
    const userId = c.var.session!.userId
    const row = await c.var.repos.exercises.getForActor(userId, c.req.param('id'))
    if (!row) throw errors.notFound('Exercise not found.')
    return c.json(toDto(row))
  })
  // --- recent-sets history (for the in-workout "LAST" hint) ----------
  // Recent sessions' working sets for one exercise, newest first. Powers
  // the live logging screen's "last time you did this" line + drawer.
  // 404s an exercise the actor can't see (getForActor is the guard).
  .get('/api/v1/ui/exercises/:id/history', async (c) => {
    const userId = c.var.session!.userId
    const exerciseId = c.req.param('id')
    const exercise = await c.var.repos.exercises.getForActor(userId, exerciseId)
    if (!exercise) throw errors.notFound('Exercise not found.')

    // limit = number of past SESSIONS to return (default 5, clamped 1..20).
    // Guard the empty/missing param explicitly: Number(null) and Number('')
    // are 0 (not NaN), which would otherwise clamp the default down to 1.
    const rawParam = new URL(c.req.url).searchParams.get('limit')
    const rawLimit = rawParam == null || rawParam === '' ? NaN : Number(rawParam)
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(20, Math.trunc(rawLimit)))
      : 5

    const rows = await c.var.repos.insights.recentSetsForExercise(userId, exerciseId)
    const sessions = groupExerciseHistory(rows, limit)

    // Private + short: history changes only when the user logs a workout.
    c.header('Cache-Control', 'private, max-age=60')
    return c.json({ exerciseId, exerciseName: exercise.name, sessions })
  })
  // --- create custom (find-or-create, per-owner) ---------------------
  // Layers TWO independent dedup keys: the pre-existing per-owner NAME
  // find-or-create (unrelated to offline retries — a real "you already
  // have an exercise called that" business rule), and the offline-create
  // `ref` idempotency key (an offline client's stable tmpId). ref is
  // checked FIRST — it's the authoritative identity for a retried create
  // — then the existing name-based logic runs unchanged. See
  // apps/fitness-api/src/lib/idempotent-create.ts for why a genuine name
  // collision can't be mistaken for a ref replay.
  .post('/api/v1/ui/exercises', async (c) => {
    const userId = c.var.session!.userId
    const parsed = createCustomExerciseSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data
    // zod's `.trim()` strips leading/trailing whitespace; normalizeExerciseName
    // also collapses internal whitespace runs ("Back   Squat" -> "Back Squat"),
    // which is what makes find-or-create idempotent across small typing nits.
    const name = normalizeExerciseName(body.name)
    const ref = body.ref ?? null

    let outcome: { record: ExerciseRecord; viaNameMatch: boolean; idempotent: boolean }
    try {
      const result = await idempotentCreate<{ record: ExerciseRecord; viaNameMatch: boolean }>({
        ref,
        findByRef: async () => {
          if (ref === null) return null
          const existing = await c.var.repos.exercises.findByOwnerAndRef(userId, ref)
          return existing ? { record: existing, viaNameMatch: false } : null
        },
        create: async () => {
          // Pre-check against this owner's custom rows (not global ones —
          // a custom name may intentionally shadow a global movement).
          // This is the pre-existing find-or-create; unrelated to ref.
          const existingByName = await c.var.repos.exercises.findCustomByName(userId, name)
          if (existingByName) return { record: existingByName, viaNameMatch: true }
          const created = await c.var.repos.exercises.createCustom({
            id: `fx_${ulid()}`,
            ownerUserId: userId,
            name,
            ref,
            discipline: body.discipline,
            movementPattern: body.movementPattern,
            metricShape: body.metricShape,
            unilateral: body.unilateral,
            muscles: body.muscles,
          })
          return { record: created, viaNameMatch: false }
        },
      })
      outcome = { ...result.row, idempotent: result.idempotent }
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        // Lost a concurrent insert race on the NAME index (not ref —
        // idempotentCreate already tried + failed the ref-based re-find
        // before rethrowing here). Return the row the winner created.
        const raced = await c.var.repos.exercises.findCustomByName(userId, name)
        if (raced) return c.json(toDto(raced), 200)
        throw errors.conflict('exercise_name_taken', 'You already have an exercise with that name.')
      }
      throw err
    }

    if (outcome.idempotent) return c.json({ ...toDto(outcome.record), idempotent: true }, 200)
    if (outcome.viaNameMatch) return c.json(toDto(outcome.record), 200)
    return c.json(toDto(outcome.record), 201)
  })
  // --- patch own custom ------------------------------------------------
  // Global rows and other users' customs resolve to null in the repo and
  // 404 here — an owner check by construction, not by trust.
  .patch('/api/v1/ui/exercises/:id', async (c) => {
    const userId = c.var.session!.userId
    const parsed = patchCustomExerciseSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data
    // Build the fields object without explicit-undefined keys
    // (exactOptionalPropertyTypes).
    const fields: import('../repos/types.js').PatchCustomExerciseFields = {}
    if (body.name !== undefined) fields.name = normalizeExerciseName(body.name)
    if (body.discipline !== undefined) fields.discipline = body.discipline
    if (body.movementPattern !== undefined) fields.movementPattern = body.movementPattern
    if (body.metricShape !== undefined) fields.metricShape = body.metricShape
    if (body.unilateral !== undefined) fields.unilateral = body.unilateral
    if (body.muscles !== undefined) fields.muscles = body.muscles
    try {
      const updated = await c.var.repos.exercises.patchCustom(
        userId,
        c.req.param('id'),
        fields,
      )
      if (!updated) throw errors.notFound('Exercise not found.')
      return c.json(toDto(updated))
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict(
          'exercise_name_taken',
          'You already have an exercise with that name.',
        )
      }
      throw err
    }
  })
  // --- delete own custom -----------------------------------------------
  .delete('/api/v1/ui/exercises/:id', async (c) => {
    const userId = c.var.session!.userId
    const outcome = await c.var.repos.exercises.deleteCustom(userId, c.req.param('id'))
    if (outcome === 'not_found') throw errors.notFound('Exercise not found.')
    if (outcome === 'referenced') {
      throw errors.conflict(
        'exercise_in_use',
        'That exercise has logged history and can’t be deleted.',
      )
    }
    return c.json({ ok: true as const })
  })
