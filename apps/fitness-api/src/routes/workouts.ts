import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  createWorkoutSchema,
  patchWorkoutSchema,
  type WorkoutDto,
  type WorkoutSetDto,
  type WorkoutSetInput,
} from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { NewWorkoutSet, WorkoutRecord, WorkoutSetRecord } from '../repos/types.js'
import { idempotentCreate } from '../lib/idempotent-create.js'
import { readJsonBody } from './_body.js'
import { parseDateRangeQuery } from './_query.js'

// The workout (training session) logging UI surface (cookie + CSRF +
// session gated in build-app). Scope every read to the actor's own rows;
// set exercise references are validated for actor visibility on write.

// Build a NewWorkoutSet from validated input, only attaching optional fields
// when they are actually present (exactOptionalPropertyTypes enforcement).
function buildNewSet(s: WorkoutSetInput, fallbackIndex: number): NewWorkoutSet {
  const set: NewWorkoutSet = {
    id: `fset_${ulid()}`,
    exerciseId: s.exerciseId,
    setIndex: s.setIndex ?? fallbackIndex,
  }
  if (s.reps !== undefined) set.reps = s.reps
  if (s.loadKg !== undefined) set.loadKg = s.loadKg
  if (s.calories !== undefined) set.calories = s.calories
  if (s.distanceM !== undefined) set.distanceM = s.distanceM
  if (s.timeS !== undefined) set.timeS = s.timeS
  if (s.inclinePct !== undefined) set.inclinePct = s.inclinePct
  if (s.rounds !== undefined) set.rounds = s.rounds
  if (s.rpe !== undefined) set.rpe = s.rpe
  if (s.notes !== undefined) set.notes = s.notes
  set.setType = s.setType ?? 'working'
  return set
}

function setToDto(s: WorkoutSetRecord): WorkoutSetDto {
  return {
    id: s.id,
    exerciseId: s.exerciseId,
    setIndex: s.setIndex,
    reps: s.reps,
    loadKg: s.loadKg,
    calories: s.calories,
    distanceM: s.distanceM,
    timeS: s.timeS,
    inclinePct: s.inclinePct,
    rounds: s.rounds,
    rpe: s.rpe,
    notes: s.notes,
    setType: s.setType,
  }
}

function toDto(r: WorkoutRecord): WorkoutDto {
  return {
    id: r.id,
    performedAt: r.performedAt.toISOString(),
    modality: r.modality as WorkoutDto['modality'],
    title: r.title,
    durationS: r.durationS,
    location: r.location,
    rpe: r.rpe,
    notes: r.notes,
    payload: r.payload,
    ref: r.ref,
    sets: r.sets.map(setToDto),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export const workoutsRoutes = new Hono<HonoApp>()
  // --- create --------------------------------------------------------
  .post('/api/v1/ui/workouts', async (c) => {
    const userId = c.var.session!.userId
    const parsed = createWorkoutSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // Validate exercise visibility for all sets in one batched query
    // (avoids N serial D1 round-trips for each set).
    if (body.sets.length > 0) {
      const setExIds = [...new Set(body.sets.map((s) => s.exerciseId))]
      const visible = await c.var.repos.exercises.listForActorByIds(userId, setExIds)
      for (const s of body.sets) {
        if (!visible.has(s.exerciseId)) {
          throw errors.validation({
            issues: [
              {
                code: 'custom',
                path: ['sets', 'exerciseId'],
                message: `Exercise "${s.exerciseId}" not found or not visible to you.`,
              },
            ],
          })
        }
      }
    }

    const workoutId = `fs_${ulid()}`
    const ref = body.ref ?? null
    // Build the workout insert, only attaching optional fields when present.
    const workoutCreate: Parameters<typeof c.var.repos.workouts.create>[0] = {
      id: workoutId,
      userId,
      performedAt: new Date(body.performedAt),
      modality: body.modality,
      ref,
      sets: body.sets.map((s, i) => buildNewSet(s, i)),
    }
    if (body.title !== undefined) workoutCreate.title = body.title
    if (body.durationS !== undefined) workoutCreate.durationS = body.durationS
    if (body.location !== undefined) workoutCreate.location = body.location
    if (body.rpe !== undefined) workoutCreate.rpe = body.rpe
    if (body.notes !== undefined) workoutCreate.notes = body.notes
    if (body.payload !== undefined) workoutCreate.payload = body.payload

    const { row, idempotent } = await idempotentCreate({
      ref,
      findByRef: () =>
        ref === null ? Promise.resolve(null) : c.var.repos.workouts.findByUserAndRef(userId, ref),
      create: () => c.var.repos.workouts.create(workoutCreate),
    })
    if (idempotent) return c.json({ ...toDto(row), idempotent: true }, 200)
    return c.json(toDto(row), 201)
  })
  // --- list ----------------------------------------------------------
  .get('/api/v1/ui/workouts', async (c) => {
    const userId = c.var.session!.userId
    const url = new URL(c.req.url)
    const limitParam = url.searchParams.get('limit')

    const filter: { from?: Date; to?: Date; limit?: number } = parseDateRangeQuery(url)
    if (limitParam) {
      const n = parseInt(limitParam, 10)
      if (!isNaN(n) && n > 0) filter.limit = n
    }

    const rows = await c.var.repos.workouts.listForActor(userId, filter)
    return c.json({ workouts: rows.map(toDto) })
  })
  // --- get one -------------------------------------------------------
  .get('/api/v1/ui/workouts/:id', async (c) => {
    const userId = c.var.session!.userId
    const row = await c.var.repos.workouts.getForActor(userId, c.req.param('id'))
    if (!row) throw errors.notFound('Workout not found.')
    return c.json(toDto(row))
  })
  // --- patch ---------------------------------------------------------
  .patch('/api/v1/ui/workouts/:id', async (c) => {
    const userId = c.var.session!.userId
    const parsed = patchWorkoutSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // When sets are supplied in the patch, validate exercise visibility in
    // one batched query (avoids N serial D1 round-trips for each set).
    if (body.sets && body.sets.length > 0) {
      const setExIds = [...new Set(body.sets.map((s) => s.exerciseId))]
      const visible = await c.var.repos.exercises.listForActorByIds(userId, setExIds)
      for (const s of body.sets) {
        if (!visible.has(s.exerciseId)) {
          throw errors.validation({
            issues: [
              {
                code: 'custom',
                path: ['sets', 'exerciseId'],
                message: `Exercise "${s.exerciseId}" not found or not visible to you.`,
              },
            ],
          })
        }
      }
    }

    const fields: import('../repos/types.js').PatchWorkoutFields = {}
    if (body.performedAt !== undefined) fields.performedAt = new Date(body.performedAt)
    if (body.modality !== undefined) fields.modality = body.modality
    if ('title' in body) fields.title = body.title ?? null
    if ('durationS' in body) fields.durationS = body.durationS ?? null
    if ('location' in body) fields.location = body.location ?? null
    if ('rpe' in body) fields.rpe = body.rpe ?? null
    if ('notes' in body) fields.notes = body.notes ?? null
    if ('payload' in body) fields.payload = body.payload ?? null

    const newSets = body.sets?.map((s, i) => buildNewSet(s, i))

    const updated = await c.var.repos.workouts.update(
      userId,
      c.req.param('id'),
      fields,
      newSets,
    )
    if (!updated) throw errors.notFound('Workout not found.')
    return c.json(toDto(updated))
  })
  // --- delete --------------------------------------------------------
  .delete('/api/v1/ui/workouts/:id', async (c) => {
    const userId = c.var.session!.userId
    const ok = await c.var.repos.workouts.delete(userId, c.req.param('id'))
    if (!ok) throw errors.notFound('Workout not found.')
    return c.json({ ok: true })
  })
