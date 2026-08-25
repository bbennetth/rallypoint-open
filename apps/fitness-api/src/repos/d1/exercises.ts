import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { exerciseMuscles, exercises, workoutSets } from '@rallypoint/fitness-db'
import type {
  ExerciseFilter,
  ExerciseRecord,
  ExerciseRepo,
  NewCustomExercise,
  NewGlobalExercise,
  PatchCustomExerciseFields,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'
import { chunkForBoundParams } from '@rallypoint/api-kit'

type ExerciseRow = typeof exercises.$inferSelect

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

// 3 bound params per exercise_muscles row. The muscles input array carries
// no zod .max(), so chunk the bulk insert under D1's 100-bound-param cap.
const EXERCISE_MUSCLE_INSERT_COLUMNS = 3

function muscleInsertStmts(
  db: Db,
  exerciseId: string,
  muscles: { muscleId: string; role: string }[],
): BatchItem<'sqlite'>[] {
  const rows = muscles.map((m) => ({ exerciseId, muscleId: m.muscleId, role: m.role }))
  return chunkForBoundParams(rows, EXERCISE_MUSCLE_INSERT_COLUMNS).map(
    (chunk) => db.insert(exerciseMuscles).values(chunk) as BatchItem<'sqlite'>,
  )
}

// Attach muscle maps to a set of exercise rows in ONE follow-up query
// (no N+1), then assemble in id order matching the input.
async function withMuscles(db: Db, rows: ExerciseRow[]): Promise<ExerciseRecord[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  // Chunk the id list — callers like listForActorByIds can pass 200 ids
  // (one per workout set), past D1's 100-bound-parameter cap.
  const maps = (
    await Promise.all(
      chunkForBoundParams(ids, 1).map((chunk) =>
        db.select().from(exerciseMuscles).where(inArray(exerciseMuscles.exerciseId, chunk)),
      ),
    )
  ).flat()
  const byExercise = new Map<string, { muscleId: string; role: string }[]>()
  for (const m of maps) {
    const list = byExercise.get(m.exerciseId)
    if (list) list.push({ muscleId: m.muscleId, role: m.role })
    else byExercise.set(m.exerciseId, [{ muscleId: m.muscleId, role: m.role }])
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    ownerUserId: r.ownerUserId ?? null,
    discipline: r.discipline,
    movementPattern: r.movementPattern,
    metricShape: r.metricShape,
    unilateral: r.unilateral,
    muscles: byExercise.get(r.id) ?? [],
    ref: r.ref ?? null,
  }))
}

export class D1ExerciseRepo implements ExerciseRepo {
  constructor(private readonly db: Db) {}

  async listForActor(actorUserId: string, filter: ExerciseFilter): Promise<ExerciseRecord[]> {
    // Visible = curated global (owner NULL) OR the actor's own custom rows.
    return this.listWhere(
      or(isNull(exercises.ownerUserId), eq(exercises.ownerUserId, actorUserId)),
      filter,
    )
  }

  // Shared filtered-list body for the actor and admin scopes: `visible`
  // sets the ownership boundary, `filter` the catalog facets.
  private async listWhere(
    visible: ReturnType<typeof or> | ReturnType<typeof isNull>,
    filter: ExerciseFilter,
  ): Promise<ExerciseRecord[]> {
    const conds = [visible]
    if (filter.discipline) conds.push(eq(exercises.discipline, filter.discipline))
    if (filter.movementPattern) conds.push(eq(exercises.movementPattern, filter.movementPattern))
    if (filter.q && filter.q.trim()) {
      const needle = `%${escapeLike(filter.q.trim())}%`
      conds.push(sql`lower(${exercises.name}) LIKE lower(${needle}) ESCAPE '\\'`)
    }
    if (filter.groupId) {
      // Exercises working any muscle in the requested taxonomy group.
      conds.push(
        sql`EXISTS (SELECT 1 FROM exercise_muscles em JOIN muscles m ON em.muscle_id = m.id
              WHERE em.exercise_id = ${exercises.id} AND m.group_id = ${filter.groupId})`,
      )
    }
    if (filter.muscleId) {
      // Exercises working one specific muscle (lats, biceps, …).
      conds.push(
        sql`EXISTS (SELECT 1 FROM exercise_muscles em
              WHERE em.exercise_id = ${exercises.id} AND em.muscle_id = ${filter.muscleId})`,
      )
    }
    // LEFT JOIN the muscle maps in ONE query and group in JS. A second
    // inArray(ids) query would blow D1's ~100 bound-parameter cap when the
    // whole catalog (150+ rows) is listed.
    const rows = await this.db
      .select({ ex: exercises, muscleId: exerciseMuscles.muscleId, role: exerciseMuscles.role })
      .from(exercises)
      .leftJoin(exerciseMuscles, eq(exerciseMuscles.exerciseId, exercises.id))
      .where(and(...conds))
      .orderBy(asc(sql`lower(${exercises.name})`))

    const order: string[] = []
    const byId = new Map<string, ExerciseRecord>()
    for (const row of rows) {
      let rec = byId.get(row.ex.id)
      if (!rec) {
        rec = {
          id: row.ex.id,
          name: row.ex.name,
          ownerUserId: row.ex.ownerUserId ?? null,
          discipline: row.ex.discipline,
          movementPattern: row.ex.movementPattern,
          metricShape: row.ex.metricShape,
          unilateral: row.ex.unilateral,
          muscles: [],
          ref: row.ex.ref ?? null,
        }
        byId.set(row.ex.id, rec)
        order.push(row.ex.id)
      }
      if (row.muscleId) rec.muscles.push({ muscleId: row.muscleId, role: row.role! })
    }
    return order.map((id) => byId.get(id)!)
  }

  // --- admin scope (FITNESS service binding only) ---------------------

  async listGlobal(filter: ExerciseFilter): Promise<ExerciseRecord[]> {
    return this.listWhere(isNull(exercises.ownerUserId), filter)
  }

  async getGlobal(id: string): Promise<ExerciseRecord | null> {
    const rows = await this.db
      .select()
      .from(exercises)
      .where(and(eq(exercises.id, id), isNull(exercises.ownerUserId)))
      .limit(1)
    const [withM] = await withMuscles(this.db, rows)
    return withM ?? null
  }

  async patchGlobal(
    id: string,
    fields: PatchCustomExerciseFields,
  ): Promise<ExerciseRecord | null> {
    const scope = and(eq(exercises.id, id), isNull(exercises.ownerUserId))
    const existing = await this.db.select().from(exercises).where(scope).limit(1)
    if (existing.length === 0) return null

    const colPatch: Partial<typeof exercises.$inferInsert> = {}
    if (fields.name !== undefined) colPatch.name = fields.name
    if (fields.discipline !== undefined) colPatch.discipline = fields.discipline
    if (fields.movementPattern !== undefined) colPatch.movementPattern = fields.movementPattern
    if (fields.metricShape !== undefined) colPatch.metricShape = fields.metricShape
    if (fields.unilateral !== undefined) colPatch.unilateral = fields.unilateral
    if (Object.keys(colPatch).length > 0) {
      try {
        await this.db.update(exercises).set(colPatch).where(scope)
      } catch (err) {
        throw mapUniqueViolation(err)
      }
    }
    if (fields.muscles !== undefined) {
      // Same atomic delete+insert batch as patchCustom — D1 has no
      // interactive transactions.
      type Stmt = BatchItem<'sqlite'>
      const deleteStmt = this.db
        .delete(exerciseMuscles)
        .where(eq(exerciseMuscles.exerciseId, id)) as Stmt
      await this.db.batch([deleteStmt, ...muscleInsertStmts(this.db, id, fields.muscles)])
    }
    return this.getGlobal(id)
  }

  async getForActor(actorUserId: string, id: string): Promise<ExerciseRecord | null> {
    const rows = await this.db
      .select()
      .from(exercises)
      .where(
        and(
          eq(exercises.id, id),
          or(isNull(exercises.ownerUserId), eq(exercises.ownerUserId, actorUserId)),
        ),
      )
      .limit(1)
    const [withM] = await withMuscles(this.db, rows)
    return withM ?? null
  }

  async listForActorByIds(
    actorUserId: string,
    ids: string[],
  ): Promise<Map<string, ExerciseRecord>> {
    if (ids.length === 0) return new Map()
    // The workout routes pass one id per set (up to 200) — chunk so each
    // SELECT stays under D1's 100-bound-parameter cap (1 reserved for
    // actorUserId).
    const rows = (
      await Promise.all(
        chunkForBoundParams(ids, 1, 1).map((chunk) =>
          this.db
            .select()
            .from(exercises)
            .where(
              and(
                inArray(exercises.id, chunk),
                or(isNull(exercises.ownerUserId), eq(exercises.ownerUserId, actorUserId)),
              ),
            ),
        ),
      )
    ).flat()
    const records = await withMuscles(this.db, rows)
    const map = new Map<string, ExerciseRecord>()
    for (const r of records) map.set(r.id, r)
    return map
  }

  async findCustomByName(actorUserId: string, name: string): Promise<ExerciseRecord | null> {
    const rows = await this.db
      .select()
      .from(exercises)
      .where(
        and(
          eq(exercises.ownerUserId, actorUserId),
          sql`lower(${exercises.name}) = lower(${name})`,
        ),
      )
      .limit(1)
    const [withM] = await withMuscles(this.db, rows)
    return withM ?? null
  }

  async findByOwnerAndRef(actorUserId: string, ref: string): Promise<ExerciseRecord | null> {
    const rows = await this.db
      .select()
      .from(exercises)
      .where(and(eq(exercises.ownerUserId, actorUserId), eq(exercises.ref, ref)))
      .limit(1)
    const [withM] = await withMuscles(this.db, rows)
    return withM ?? null
  }

  async createCustom(input: NewCustomExercise): Promise<ExerciseRecord> {
    try {
      await this.db.insert(exercises).values({
        id: input.id,
        name: input.name,
        ownerUserId: input.ownerUserId,
        discipline: input.discipline,
        movementPattern: input.movementPattern,
        metricShape: input.metricShape,
        unilateral: input.unilateral,
        ref: input.ref ?? null,
      })
    } catch (err) {
      throw mapUniqueViolation(err)
    }
    if (input.muscles.length > 0) {
      const [first, ...rest] = muscleInsertStmts(this.db, input.id, input.muscles)
      await this.db.batch([first!, ...rest])
    }
    return {
      id: input.id,
      name: input.name,
      ownerUserId: input.ownerUserId,
      discipline: input.discipline,
      movementPattern: input.movementPattern,
      metricShape: input.metricShape,
      unilateral: input.unilateral,
      muscles: input.muscles,
      ref: input.ref ?? null,
    }
  }

  async patchCustom(
    actorUserId: string,
    id: string,
    fields: PatchCustomExerciseFields,
  ): Promise<ExerciseRecord | null> {
    const owned = and(eq(exercises.id, id), eq(exercises.ownerUserId, actorUserId))
    const existing = await this.db.select().from(exercises).where(owned).limit(1)
    if (existing.length === 0) return null

    const colPatch: Partial<typeof exercises.$inferInsert> = {}
    if (fields.name !== undefined) colPatch.name = fields.name
    if (fields.discipline !== undefined) colPatch.discipline = fields.discipline
    if (fields.movementPattern !== undefined) colPatch.movementPattern = fields.movementPattern
    if (fields.metricShape !== undefined) colPatch.metricShape = fields.metricShape
    if (fields.unilateral !== undefined) colPatch.unilateral = fields.unilateral
    if (Object.keys(colPatch).length > 0) {
      try {
        await this.db.update(exercises).set(colPatch).where(owned)
      } catch (err) {
        throw mapUniqueViolation(err)
      }
    }
    if (fields.muscles !== undefined) {
      // Wrap the delete + optional insert in a single db.batch([...]) so an
      // interruption between the two can't leave the exercise with no muscle
      // map. D1 has no interactive transactions; batch() is the atomic primitive.
      type Stmt = BatchItem<'sqlite'>
      const deleteStmt = this.db
        .delete(exerciseMuscles)
        .where(eq(exerciseMuscles.exerciseId, id)) as Stmt
      await this.db.batch([deleteStmt, ...muscleInsertStmts(this.db, id, fields.muscles)])
    }
    return this.getForActor(actorUserId, id)
  }

  async deleteCustom(
    actorUserId: string,
    id: string,
  ): Promise<'deleted' | 'not_found' | 'referenced'> {
    const owned = and(eq(exercises.id, id), eq(exercises.ownerUserId, actorUserId))
    const existing = await this.db.select().from(exercises).where(owned).limit(1)
    if (existing.length === 0) return 'not_found'
    // Logged history must stay intact — refuse the delete while any
    // workout set references this exercise.
    const refs = await this.db
      .select({ id: workoutSets.id })
      .from(workoutSets)
      .where(eq(workoutSets.exerciseId, id))
      .limit(1)
    if (refs.length > 0) return 'referenced'
    await this.db.delete(exerciseMuscles).where(eq(exerciseMuscles.exerciseId, id))
    await this.db.delete(exercises).where(owned)
    return 'deleted'
  }

  async searchGlobalCandidates(name: string, limit: number): Promise<ExerciseRecord[]> {
    // Duplicate-scan shortlist: global rows matching ANY name token (OR
    // semantics — "DB Bench Press" should surface "Bench Press" even
    // though "DB" matches nothing). Alphabetical keeps the shortlist
    // deterministic for the prompt.
    const words = name.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    const wordConds = words.map((w) => {
      const p = `%${escapeLike(w)}%`
      return sql`lower(${exercises.name}) LIKE lower(${p}) ESCAPE '\\'`
    })
    const rows = await this.db
      .select()
      .from(exercises)
      .where(and(isNull(exercises.ownerUserId), or(...wordConds)))
      .orderBy(asc(sql`lower(${exercises.name})`))
      .limit(Math.min(Math.max(limit, 1), 20))
    return withMuscles(this.db, rows)
  }

  async findGlobalByName(name: string): Promise<ExerciseRecord | null> {
    const rows = await this.db
      .select()
      .from(exercises)
      .where(and(isNull(exercises.ownerUserId), sql`lower(${exercises.name}) = lower(${name})`))
      .limit(1)
    const [withM] = await withMuscles(this.db, rows)
    return withM ?? null
  }

  async createGlobal(input: NewGlobalExercise): Promise<ExerciseRecord> {
    try {
      await this.db.insert(exercises).values({
        id: input.id,
        name: input.name,
        ownerUserId: null,
        discipline: input.discipline,
        movementPattern: input.movementPattern,
        metricShape: input.metricShape,
        unilateral: input.unilateral,
      })
    } catch (err) {
      throw mapUniqueViolation(err)
    }
    if (input.muscles.length > 0) {
      const [first, ...rest] = muscleInsertStmts(this.db, input.id, input.muscles)
      await this.db.batch([first!, ...rest])
    }
    return {
      id: input.id,
      name: input.name,
      ownerUserId: null,
      discipline: input.discipline,
      movementPattern: input.movementPattern,
      metricShape: input.metricShape,
      unilateral: input.unilateral,
      muscles: input.muscles,
      ref: null,
    }
  }
}
