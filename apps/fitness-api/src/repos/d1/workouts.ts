import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { workouts, workoutSets } from '@rallypoint/fitness-db'
import type {
  NewWorkout,
  NewWorkoutSet,
  PatchWorkoutFields,
  SetType,
  WorkoutListFilter,
  WorkoutRecord,
  WorkoutRepo,
  WorkoutSetRecord,
} from '../types.js'
import type { Db } from './db.js'
import { chunkForBoundParams } from '@rallypoint/api-kit'
import { mapUniqueViolation } from './_errors.js'

type WorkoutRow = typeof workouts.$inferSelect
type Stmt = BatchItem<'sqlite'>

// Worst-case bound params per workout_sets insert row (all 14 columns
// supplied). createWorkoutSchema allows up to 200 sets, so a single
// multi-row VALUES would bind far past D1's 100-variable cap.
const WORKOUT_SET_INSERT_COLUMNS = 14

function rowToWorkoutRecord(w: WorkoutRow, sets: WorkoutSetRecord[]): WorkoutRecord {
  return {
    id: w.id,
    userId: w.userId,
    performedAt: w.performedAt,
    modality: w.modality,
    title: w.title ?? null,
    durationS: w.durationS ?? null,
    location: w.location ?? null,
    rpe: w.rpe ?? null,
    notes: w.notes ?? null,
    payload: w.payload != null ? (JSON.parse(w.payload) as Record<string, unknown>) : null,
    ref: w.ref ?? null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    sets,
  }
}

// Build the flat insert row for a set, translating optional → nullable for D1.
function setInsertValues(s: NewWorkoutSet, workoutId: string, fallbackIndex: number) {
  const row: {
    id: string
    workoutId: string
    exerciseId: string
    setIndex: number
    reps?: number
    loadKg?: number
    calories?: number
    distanceM?: number
    timeS?: number
    inclinePct?: number
    rounds?: number
    rpe?: number
    notes?: string
    setType?: SetType
  } = {
    id: s.id,
    workoutId,
    exerciseId: s.exerciseId,
    setIndex: s.setIndex ?? fallbackIndex,
  }
  if (s.reps !== undefined) row.reps = s.reps
  if (s.loadKg !== undefined) row.loadKg = s.loadKg
  if (s.calories !== undefined) row.calories = s.calories
  if (s.distanceM !== undefined) row.distanceM = s.distanceM
  if (s.timeS !== undefined) row.timeS = s.timeS
  if (s.inclinePct !== undefined) row.inclinePct = s.inclinePct
  if (s.rounds !== undefined) row.rounds = s.rounds
  if (s.rpe !== undefined) row.rpe = s.rpe
  if (s.notes !== undefined) row.notes = s.notes
  row.setType = s.setType ?? 'working'
  return row
}

// Build a WorkoutSetRecord from a NewWorkoutSet (for returning after a write
// without re-reading from D1).
function setRecordFromNew(s: NewWorkoutSet, workoutId: string, fallbackIndex: number): WorkoutSetRecord {
  return {
    id: s.id,
    workoutId,
    exerciseId: s.exerciseId,
    setIndex: s.setIndex ?? fallbackIndex,
    reps: s.reps ?? null,
    loadKg: s.loadKg ?? null,
    calories: s.calories ?? null,
    distanceM: s.distanceM ?? null,
    timeS: s.timeS ?? null,
    inclinePct: s.inclinePct ?? null,
    rounds: s.rounds ?? null,
    rpe: s.rpe ?? null,
    notes: s.notes ?? null,
    setType: s.setType ?? 'working',
  }
}

export class D1WorkoutRepo implements WorkoutRepo {
  constructor(private readonly db: Db) {}

  async listForActor(userId: string, filter: WorkoutListFilter): Promise<WorkoutRecord[]> {
    const limit = Math.min(filter.limit ?? 50, 200)

    const conds = [eq(workouts.userId, userId)]
    if (filter.from) conds.push(gte(workouts.performedAt, filter.from))
    // Half-open window `[from, to)` matches DayWindow.end semantics
    // (exclusive — local midnight of the NEXT day).
    if (filter.to) conds.push(lt(workouts.performedAt, filter.to))

    // Load workouts + sets in ONE LEFT JOIN query — flat selection, grouped in
    // JS — to avoid a second inArray(ids) query that would blow D1's
    // ~100-bound-parameter cap on a multi-workout list. Mirrors the exercises
    // LEFT-JOIN-to-avoid-inArray pattern (flat columns, not object nesting).
    const rows = await this.db
      .select({
        // workout columns
        w: workouts,
        // set columns — nullable because of LEFT JOIN
        sId: workoutSets.id,
        sWorkoutId: workoutSets.workoutId,
        sExerciseId: workoutSets.exerciseId,
        sSetIndex: workoutSets.setIndex,
        sReps: workoutSets.reps,
        sLoadKg: workoutSets.loadKg,
        sCalories: workoutSets.calories,
        sDistanceM: workoutSets.distanceM,
        sTimeS: workoutSets.timeS,
        sInclinePct: workoutSets.inclinePct,
        sRounds: workoutSets.rounds,
        sRpe: workoutSets.rpe,
        sNotes: workoutSets.notes,
        sSetType: workoutSets.setType,
      })
      .from(workouts)
      .leftJoin(workoutSets, eq(workoutSets.workoutId, workouts.id))
      .where(and(...conds))
      .orderBy(desc(workouts.performedAt), sql`${workouts.id} DESC`)
      // Pessimistic row cap: up to 50 sets per workout, but capped at
      // 500 total rows so a large page (limit=200) never triggers a
      // 10 000-row scan. The JS grouping below stops collecting workouts
      // once `order.length >= limit`, so the effective cap is fine.
      .limit(Math.min(limit * 50, 500))

    // Group in JS, preserving newest-first order.
    const order: string[] = []
    const byId = new Map<string, { w: WorkoutRow; sets: WorkoutSetRecord[] }>()
    for (const row of rows) {
      let entry = byId.get(row.w.id)
      if (!entry) {
        if (order.length >= limit) continue // already have enough workouts
        entry = { w: row.w, sets: [] }
        byId.set(row.w.id, entry)
        order.push(row.w.id)
      }
      // sId is null when the workout has no sets (left-join NULL row).
      if (row.sId != null) {
        entry.sets.push({
          id: row.sId,
          workoutId: row.sWorkoutId ?? row.w.id,
          exerciseId: row.sExerciseId ?? '',
          setIndex: row.sSetIndex ?? 0,
          reps: row.sReps,
          loadKg: row.sLoadKg,
          calories: row.sCalories,
          distanceM: row.sDistanceM,
          timeS: row.sTimeS,
          inclinePct: row.sInclinePct,
          rounds: row.sRounds,
          rpe: row.sRpe,
          notes: row.sNotes,
          setType: (row.sSetType ?? 'working') as SetType,
        })
      }
    }

    const result: WorkoutRecord[] = []
    for (const wId of order) {
      const e = byId.get(wId)
      if (!e) continue
      e.sets.sort((a, b) => a.setIndex - b.setIndex)
      result.push(rowToWorkoutRecord(e.w, e.sets))
    }
    return result
  }

  async getForActor(userId: string, id: string): Promise<WorkoutRecord | null> {
    const rows = await this.db
      .select({
        w: workouts,
        sId: workoutSets.id,
        sWorkoutId: workoutSets.workoutId,
        sExerciseId: workoutSets.exerciseId,
        sSetIndex: workoutSets.setIndex,
        sReps: workoutSets.reps,
        sLoadKg: workoutSets.loadKg,
        sCalories: workoutSets.calories,
        sDistanceM: workoutSets.distanceM,
        sTimeS: workoutSets.timeS,
        sInclinePct: workoutSets.inclinePct,
        sRounds: workoutSets.rounds,
        sRpe: workoutSets.rpe,
        sNotes: workoutSets.notes,
        sSetType: workoutSets.setType,
      })
      .from(workouts)
      .leftJoin(workoutSets, eq(workoutSets.workoutId, workouts.id))
      .where(and(eq(workouts.id, id), eq(workouts.userId, userId)))

    if (rows.length === 0) return null

    const firstRow = rows[0]
    if (firstRow === undefined) return null

    const w = firstRow.w
    const sets: WorkoutSetRecord[] = []
    for (const row of rows) {
      if (row.sId != null) {
        sets.push({
          id: row.sId,
          workoutId: row.sWorkoutId ?? id,
          exerciseId: row.sExerciseId ?? '',
          setIndex: row.sSetIndex ?? 0,
          reps: row.sReps,
          loadKg: row.sLoadKg,
          calories: row.sCalories,
          distanceM: row.sDistanceM,
          timeS: row.sTimeS,
          inclinePct: row.sInclinePct,
          rounds: row.sRounds,
          rpe: row.sRpe,
          notes: row.sNotes,
          setType: (row.sSetType ?? 'working') as SetType,
        })
      }
    }
    sets.sort((a, b) => a.setIndex - b.setIndex)
    return rowToWorkoutRecord(w, sets)
  }

  async findByUserAndRef(userId: string, ref: string): Promise<WorkoutRecord | null> {
    const rows = await this.db
      .select()
      .from(workouts)
      .where(and(eq(workouts.userId, userId), eq(workouts.ref, ref)))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    const setRows = await this.db
      .select()
      .from(workoutSets)
      .where(eq(workoutSets.workoutId, row.id))
    const sets: WorkoutSetRecord[] = setRows.map((s) => ({
      id: s.id,
      workoutId: s.workoutId,
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
      setType: (s.setType ?? 'working') as SetType,
    }))
    sets.sort((a, b) => a.setIndex - b.setIndex)
    return rowToWorkoutRecord(row, sets)
  }

  async create(input: NewWorkout): Promise<WorkoutRecord> {
    const now = new Date()
    const workoutInsert: typeof workouts.$inferInsert = {
      id: input.id,
      userId: input.userId,
      performedAt: input.performedAt,
      modality: input.modality,
      ref: input.ref ?? null,
      createdAt: now,
      updatedAt: now,
    }
    if (input.title !== undefined) workoutInsert.title = input.title
    if (input.durationS !== undefined) workoutInsert.durationS = input.durationS
    if (input.location !== undefined) workoutInsert.location = input.location
    if (input.rpe !== undefined) workoutInsert.rpe = input.rpe
    if (input.notes !== undefined) workoutInsert.notes = input.notes
    if (input.payload !== undefined) workoutInsert.payload = JSON.stringify(input.payload)

    // D1 has no interactive db.transaction(); db.batch([...]) is the atomic
    // primitive. Batching the workout header + the sets insert prevents a
    // half-written workout (header row with no sets, unrecoverable from the
    // client) when the sets insert throws.
    const headerInsert = this.db.insert(workouts).values(workoutInsert) as Stmt
    const setRecords: WorkoutSetRecord[] = []
    const stmts: [Stmt, ...Stmt[]] = [headerInsert]
    if (input.sets.length > 0) {
      const rows = input.sets.map((s, i) => setInsertValues(s, input.id, i))
      for (const chunk of chunkForBoundParams(rows, WORKOUT_SET_INSERT_COLUMNS)) {
        stmts.push(this.db.insert(workoutSets).values(chunk) as Stmt)
      }
      for (let i = 0; i < input.sets.length; i++) {
        const s = input.sets[i]
        if (s !== undefined) setRecords.push(setRecordFromNew(s, input.id, i))
      }
    }
    try {
      await this.db.batch(stmts)
    } catch (err) {
      throw mapUniqueViolation(err)
    }

    return {
      id: input.id,
      userId: input.userId,
      performedAt: input.performedAt,
      modality: input.modality,
      ref: input.ref ?? null,
      title: input.title ?? null,
      durationS: input.durationS ?? null,
      location: input.location ?? null,
      rpe: input.rpe ?? null,
      notes: input.notes ?? null,
      payload: input.payload ?? null,
      createdAt: now,
      updatedAt: now,
      sets: setRecords,
    }
  }

  async update(
    userId: string,
    id: string,
    fields: PatchWorkoutFields,
    sets?: NewWorkoutSet[],
  ): Promise<WorkoutRecord | null> {
    // Verify ownership first.
    const existing = await this.getForActor(userId, id)
    if (!existing) return null

    const now = new Date()

    // Build update values only for supplied fields.
    const updateVals: Partial<typeof workouts.$inferInsert> & { updatedAt: Date } = {
      updatedAt: now,
    }
    if (fields.performedAt !== undefined) updateVals.performedAt = fields.performedAt
    if (fields.modality !== undefined) updateVals.modality = fields.modality
    if ('title' in fields) updateVals.title = fields.title ?? null
    if ('durationS' in fields) updateVals.durationS = fields.durationS ?? null
    if ('location' in fields) updateVals.location = fields.location ?? null
    if ('rpe' in fields) updateVals.rpe = fields.rpe ?? null
    if ('notes' in fields) updateVals.notes = fields.notes ?? null
    if ('payload' in fields) {
      updateVals.payload = fields.payload != null ? JSON.stringify(fields.payload) : null
    }

    // Batch the header update + (when supplied) the sets replace. Without
    // the batch, a failure on the sets insert after the delete-then-insert
    // leaves the workout permanently set-less; with the batch, both run as
    // one atomic D1 statement set.
    const headerUpdate = this.db
      .update(workouts)
      .set(updateVals)
      .where(eq(workouts.id, id)) as Stmt
    const stmts: [Stmt, ...Stmt[]] = [headerUpdate]

    let newSetRecords: WorkoutSetRecord[] = existing.sets
    if (sets !== undefined) {
      stmts.push(this.db.delete(workoutSets).where(eq(workoutSets.workoutId, id)) as Stmt)
      newSetRecords = []
      if (sets.length > 0) {
        const rows = sets.map((s, i) => setInsertValues(s, id, i))
        for (const chunk of chunkForBoundParams(rows, WORKOUT_SET_INSERT_COLUMNS)) {
          stmts.push(this.db.insert(workoutSets).values(chunk) as Stmt)
        }
        for (let i = 0; i < sets.length; i++) {
          const s = sets[i]
          if (s !== undefined) newSetRecords.push(setRecordFromNew(s, id, i))
        }
      }
    }

    await this.db.batch(stmts)

    return {
      ...existing,
      ...(fields.performedAt !== undefined ? { performedAt: fields.performedAt } : {}),
      ...(fields.modality !== undefined ? { modality: fields.modality } : {}),
      ...('title' in fields ? { title: fields.title ?? null } : {}),
      ...('durationS' in fields ? { durationS: fields.durationS ?? null } : {}),
      ...('location' in fields ? { location: fields.location ?? null } : {}),
      ...('rpe' in fields ? { rpe: fields.rpe ?? null } : {}),
      ...('notes' in fields ? { notes: fields.notes ?? null } : {}),
      ...('payload' in fields ? { payload: fields.payload ?? null } : {}),
      updatedAt: now,
      sets: newSetRecords,
    }
  }

  async delete(userId: string, id: string): Promise<boolean> {
    // Verify ownership before delete.
    const rows = await this.db
      .select({ id: workouts.id })
      .from(workouts)
      .where(and(eq(workouts.id, id), eq(workouts.userId, userId)))
      .limit(1)
    if (rows.length === 0) return false

    // CASCADE on workoutSets via FK handles set deletion.
    await this.db.delete(workouts).where(eq(workouts.id, id))
    return true
  }
}
