import { and, desc, eq, exists, inArray, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import {
  exerciseFavorites,
  exerciseMachineSettings,
  exerciseMuscles,
  exercises,
  exerciseSubmissions,
  muscleGroups,
  muscles,
  trainingPlanItems,
  trainingPlans,
  wodTemplates,
  workouts,
  workoutSets,
} from '@rallypoint/fitness-db'
import { remapTemplateBody } from '@rallypoint/fitness-shared'
import type {
  AcceptSubmissionMigrationInput,
  NewSubmission,
  SetSubmissionReviewedFields,
  SubmissionAdminMuscle,
  SubmissionAdminRecord,
  SubmissionRecord,
  SubmissionRepo,
  SubmissionStatus,
  SubmissionWithExerciseName,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'
import { chunkForBoundParams } from '@rallypoint/api-kit'

type Stmt = BatchItem<'sqlite'>
type SubmissionRow = typeof exerciseSubmissions.$inferSelect

function rowToRecord(r: SubmissionRow): SubmissionRecord {
  return {
    id: r.id,
    exerciseId: r.exerciseId,
    userId: r.userId,
    status: r.status as SubmissionStatus,
    adminNote: r.adminNote ?? null,
    globalExerciseId: r.globalExerciseId ?? null,
    migrationStatus: r.migrationStatus as SubmissionRecord['migrationStatus'],
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt ?? null,
    migratedAt: r.migratedAt ?? null,
  }
}

/** Which exercise row carries a submission's display snapshot: the
 *  linked global exercise once approval links one (the private custom
 *  row is deleted when the user accepts the migration), else the
 *  originally submitted custom exercise. */
function snapshotExerciseId(r: SubmissionRow): string {
  return r.globalExerciseId ?? r.exerciseId
}

export class D1SubmissionsRepo implements SubmissionRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewSubmission): Promise<SubmissionRecord> {
    const now = new Date()
    try {
      // The partial UNIQUE index on (exercise_id) WHERE status='pending'
      // is the race-safe double-submit guard; the route maps the mapped
      // UniqueConstraintError to the same 409 as its pre-check.
      await this.db.insert(exerciseSubmissions).values({
        id: input.id,
        exerciseId: input.exerciseId,
        userId: input.userId,
        status: 'pending',
        migrationStatus: 'none',
        createdAt: now,
      })
    } catch (err) {
      throw mapUniqueViolation(err)
    }
    return {
      id: input.id,
      exerciseId: input.exerciseId,
      userId: input.userId,
      status: 'pending',
      adminNote: null,
      globalExerciseId: null,
      migrationStatus: 'none',
      createdAt: now,
      reviewedAt: null,
      migratedAt: null,
    }
  }

  async getById(id: string): Promise<SubmissionRecord | null> {
    const row = await this.db
      .select()
      .from(exerciseSubmissions)
      .where(eq(exerciseSubmissions.id, id))
      .get()
    return row ? rowToRecord(row) : null
  }

  async getPendingByExercise(exerciseId: string): Promise<SubmissionRecord | null> {
    const row = await this.db
      .select()
      .from(exerciseSubmissions)
      .where(
        and(
          eq(exerciseSubmissions.exerciseId, exerciseId),
          eq(exerciseSubmissions.status, 'pending'),
        ),
      )
      .get()
    return row ? rowToRecord(row) : null
  }

  async listByUser(userId: string): Promise<SubmissionWithExerciseName[]> {
    const rows = await this.db
      .select()
      .from(exerciseSubmissions)
      .where(eq(exerciseSubmissions.userId, userId))
      .orderBy(desc(exerciseSubmissions.createdAt))
    if (rows.length === 0) return []
    // Resolve names by the snapshot id: an accepted migration DELETES the
    // private custom-exercise row, so post-approval rows must read the
    // linked global exercise instead of showing a blank name.
    // Chunked — a long submission history would blow D1's 100-bound-param
    // cap in one inArray.
    const nameIds = [...new Set(rows.map((r) => snapshotExerciseId(r)))]
    const exRows = (
      await Promise.all(
        chunkForBoundParams(nameIds, 1).map((chunk) =>
          this.db
            .select({ id: exercises.id, name: exercises.name })
            .from(exercises)
            .where(inArray(exercises.id, chunk)),
        ),
      )
    ).flat()
    const nameById = new Map(exRows.map((e) => [e.id, e.name]))
    return rows.map((r) => ({
      ...rowToRecord(r),
      exerciseName: nameById.get(snapshotExerciseId(r)) ?? '',
    }))
  }

  private async withExerciseSnapshot(
    rows: SubmissionRow[],
  ): Promise<SubmissionAdminRecord[]> {
    if (rows.length === 0) return []
    // Snapshot by globalExerciseId once linked (approval links it, and an
    // accepted migration deletes the original private row), falling back
    // to the submitted custom-exercise id pre-approval — otherwise
    // approved-and-migrated submissions render blank in the admin queue.
    // Both id-list selects are chunked — the admin queue is unbounded, so a
    // long backlog would blow D1's 100-bound-param cap in one inArray.
    const exerciseIds = [...new Set(rows.map((r) => snapshotExerciseId(r)))]
    const idChunks = chunkForBoundParams(exerciseIds, 1)
    const exRows = (
      await Promise.all(
        idChunks.map((chunk) =>
          this.db.select().from(exercises).where(inArray(exercises.id, chunk)),
        ),
      )
    ).flat()
    const exById = new Map(exRows.map((e) => [e.id, e]))

    const muscleRows = (
      await Promise.all(
        idChunks.map((chunk) =>
          this.db
            .select({
              exerciseId: exerciseMuscles.exerciseId,
              muscleId: exerciseMuscles.muscleId,
              role: exerciseMuscles.role,
              muscleName: muscles.name,
              groupName: muscleGroups.name,
            })
            .from(exerciseMuscles)
            .innerJoin(muscles, eq(muscles.id, exerciseMuscles.muscleId))
            .innerJoin(muscleGroups, eq(muscleGroups.id, muscles.groupId))
            .where(inArray(exerciseMuscles.exerciseId, chunk)),
        ),
      )
    ).flat()
    const musclesByExercise = new Map<string, SubmissionAdminMuscle[]>()
    for (const m of muscleRows) {
      const list = musclesByExercise.get(m.exerciseId) ?? []
      list.push({
        muscleId: m.muscleId,
        muscleName: m.muscleName,
        groupName: m.groupName,
        role: m.role,
      })
      musclesByExercise.set(m.exerciseId, list)
    }

    return rows.map((r) => {
      const snapId = snapshotExerciseId(r)
      const ex = exById.get(snapId)
      return {
        ...rowToRecord(r),
        exercise: {
          name: ex?.name ?? '',
          discipline: ex?.discipline ?? '',
          movementPattern: ex?.movementPattern ?? '',
          metricShape: ex?.metricShape ?? '',
          unilateral: ex?.unilateral ?? false,
          muscles: musclesByExercise.get(snapId) ?? [],
        },
      }
    })
  }

  async listByStatus(status?: SubmissionStatus): Promise<SubmissionAdminRecord[]> {
    const rows = await this.db
      .select()
      .from(exerciseSubmissions)
      .where(status ? eq(exerciseSubmissions.status, status) : undefined)
      .orderBy(desc(exerciseSubmissions.createdAt))
    return this.withExerciseSnapshot(rows)
  }

  async getAdminById(id: string): Promise<SubmissionAdminRecord | null> {
    const row = await this.db
      .select()
      .from(exerciseSubmissions)
      .where(eq(exerciseSubmissions.id, id))
      .get()
    if (!row) return null
    const [withSnapshot] = await this.withExerciseSnapshot([row])
    return withSnapshot ?? null
  }

  async setReviewed(
    id: string,
    fields: SetSubmissionReviewedFields,
  ): Promise<SubmissionRecord | null> {
    const existing = await this.getById(id)
    if (!existing) return null
    const updateVals: Partial<typeof exerciseSubmissions.$inferInsert> = {
      status: fields.status,
      reviewedAt: fields.reviewedAt,
    }
    if ('adminNote' in fields) updateVals.adminNote = fields.adminNote ?? null
    if ('globalExerciseId' in fields) updateVals.globalExerciseId = fields.globalExerciseId ?? null
    if (fields.migrationStatus !== undefined) updateVals.migrationStatus = fields.migrationStatus
    await this.db
      .update(exerciseSubmissions)
      .set(updateVals)
      .where(eq(exerciseSubmissions.id, id))
    return this.getById(id)
  }

  async declineMigration(id: string): Promise<SubmissionRecord | null> {
    const existing = await this.getById(id)
    if (!existing) return null
    // Guard on migrationStatus like acceptMigration's terminal write: a
    // decline racing an in-flight accept must not clobber 'accepted' after
    // the exercise data has already been migrated.
    await this.db
      .update(exerciseSubmissions)
      .set({ migrationStatus: 'declined' })
      .where(
        and(
          eq(exerciseSubmissions.id, id),
          eq(exerciseSubmissions.migrationStatus, 'offered'),
        ),
      )
    return this.getById(id)
  }

  async acceptMigration(
    input: AcceptSubmissionMigrationInput,
  ): Promise<SubmissionRecord | null> {
    const existing = await this.getById(input.submissionId)
    if (!existing || existing.userId !== input.userId) return null

    // Pre-read whether a favorite / machine-settings row exists so the
    // batch only carries the copy+delete pairs it needs (same
    // read-then-batch shape as D1ExerciseRepo.patchCustom).
    const favoriteRow = await this.db
      .select({ userId: exerciseFavorites.userId })
      .from(exerciseFavorites)
      .where(
        and(
          eq(exerciseFavorites.userId, input.userId),
          eq(exerciseFavorites.exerciseId, input.customExerciseId),
        ),
      )
      .get()
    const machineSettingsRow = await this.db
      .select({ entries: exerciseMachineSettings.entries, updatedAt: exerciseMachineSettings.updatedAt })
      .from(exerciseMachineSettings)
      .where(
        and(
          eq(exerciseMachineSettings.userId, input.userId),
          eq(exerciseMachineSettings.exerciseId, input.customExerciseId),
        ),
      )
      .get()
    // Pre-read the submitter's own templates so their bodies (JSON,
    // holding exerciseId references at strength blocks[]/wod
    // movements[]/perMinuteBuyIn) can be rewritten in the same batch —
    // otherwise a template keeps pointing at the deleted custom id and
    // saving a workout from it 400s at the visibility check (routes/
    // workouts.ts). remapTemplateBody returns the SAME reference when
    // nothing changes, so rows with no hit are skipped below.
    const templateRows = await this.db
      .select({ id: wodTemplates.id, body: wodTemplates.body })
      .from(wodTemplates)
      .where(eq(wodTemplates.ownerUserId, input.userId))
    const templateUpdates: { id: string; body: string; next: unknown }[] = []
    for (const row of templateRows) {
      const parsed: unknown = JSON.parse(row.body)
      const next = remapTemplateBody(parsed, input.customExerciseId, input.globalExerciseId)
      if (next !== parsed) templateUpdates.push({ id: row.id, body: row.body, next })
    }

    const now = new Date()
    const stmts: Stmt[] = []

    // A decline (or double-accept) can commit between the pre-read above
    // and this batch. db.batch runs as one transaction, so guarding EVERY
    // statement on the submission still being approved+offered makes the
    // whole batch a no-op in that case — the data statements and the
    // terminal status flip can't disagree (same TOCTOU guard as
    // D1FoodSubmissionsRepo.acceptMigration).
    const stillOffered = exists(
      this.db
        .select({ one: exerciseSubmissions.id })
        .from(exerciseSubmissions)
        .where(
          and(
            eq(exerciseSubmissions.id, input.submissionId),
            eq(exerciseSubmissions.userId, input.userId),
            eq(exerciseSubmissions.status, 'approved'),
            eq(exerciseSubmissions.migrationStatus, 'offered'),
          ),
        ),
    )
    // INSERT VALUES can't carry a WHERE, so the two carry-over inserts
    // below are INSERT ... SELECT from exercise_submissions gated on the
    // same approved+offered predicate: the SELECT yields one row iff the
    // migration is still offered, zero rows (insert no-op) otherwise.
    const stillOfferedFilter = and(
      eq(exerciseSubmissions.id, input.submissionId),
      eq(exerciseSubmissions.userId, input.userId),
      eq(exerciseSubmissions.status, 'approved'),
      eq(exerciseSubmissions.migrationStatus, 'offered'),
    )

    // workout_sets: custom exercises are private per-user rows (see
    // exercises.ts schema notes — owner_user_id splits global vs. custom,
    // and there is no shared-workout mechanism anywhere in the schema a
    // custom exercise's sets could belong to another user through). The
    // WHERE is still constrained via workouts.user_id defensively, so a
    // future shared-workout feature can't silently make this cross-user.
    stmts.push(
      this.db
        .update(workoutSets)
        .set({ exerciseId: input.globalExerciseId })
        .where(
          and(
            eq(workoutSets.exerciseId, input.customExerciseId),
            inArray(
              workoutSets.workoutId,
              this.db
                .select({ id: workouts.id })
                .from(workouts)
                .where(eq(workouts.userId, input.userId)),
            ),
            stillOffered,
          ),
        ) as Stmt,
    )

    if (favoriteRow) {
      stmts.push(
        this.db
          .insert(exerciseFavorites)
          .select(
            this.db
              .select({
                userId: sql<string>`${input.userId}`.as('user_id'),
                exerciseId: sql<string>`${input.globalExerciseId}`.as('exercise_id'),
                createdAt: sql<number>`(unixepoch() * 1000)`.as('created_at'),
              })
              .from(exerciseSubmissions)
              .where(stillOfferedFilter),
          )
          .onConflictDoNothing({
            target: [exerciseFavorites.userId, exerciseFavorites.exerciseId],
          }) as Stmt,
      )
      stmts.push(
        this.db
          .delete(exerciseFavorites)
          .where(
            and(
              eq(exerciseFavorites.userId, input.userId),
              eq(exerciseFavorites.exerciseId, input.customExerciseId),
              stillOffered,
            ),
          ) as Stmt,
      )
    }

    if (machineSettingsRow) {
      stmts.push(
        this.db
          .insert(exerciseMachineSettings)
          .select(
            this.db
              .select({
                userId: sql<string>`${input.userId}`.as('user_id'),
                exerciseId: sql<string>`${input.globalExerciseId}`.as('exercise_id'),
                entries: sql<string>`${machineSettingsRow.entries}`.as('entries'),
                updatedAt: sql<number>`${machineSettingsRow.updatedAt.getTime()}`.as('updated_at'),
              })
              .from(exerciseSubmissions)
              .where(stillOfferedFilter),
          )
          .onConflictDoNothing({
            target: [exerciseMachineSettings.userId, exerciseMachineSettings.exerciseId],
          }) as Stmt,
      )
      stmts.push(
        this.db
          .delete(exerciseMachineSettings)
          .where(
            and(
              eq(exerciseMachineSettings.userId, input.userId),
              eq(exerciseMachineSettings.exerciseId, input.customExerciseId),
              stillOffered,
            ),
          ) as Stmt,
      )
    }

    // training_plan_items references catalog exercises via
    // sourceKind='exercise' + sourceId (see PLAN_SOURCE_KINDS /
    // ID_BACKED_PLAN_SOURCE_KINDS in @rallypoint/fitness-shared
    // training-plans.ts) — re-point those rows too, constrained to the
    // submitter's own plans (plan items carry no user id of their own).
    stmts.push(
      this.db
        .update(trainingPlanItems)
        .set({ sourceId: input.globalExerciseId })
        .where(
          and(
            eq(trainingPlanItems.sourceKind, 'exercise'),
            eq(trainingPlanItems.sourceId, input.customExerciseId),
            inArray(
              trainingPlanItems.planId,
              this.db
                .select({ id: trainingPlans.id })
                .from(trainingPlans)
                .where(eq(trainingPlans.ownerUserId, input.userId)),
            ),
            stillOffered,
          ),
        ) as Stmt,
    )

    // wod_templates: rewrite each changed body, scoped to id + owner +
    // the exact pre-read body (a concurrently PATCHed template is left
    // un-rewritten rather than clobbered — a stale-write race here isn't
    // worth chasing given a generic repair script can cover stragglers).
    for (const { id, body, next } of templateUpdates) {
      stmts.push(
        this.db
          .update(wodTemplates)
          .set({ body: JSON.stringify(next), updatedAt: now })
          .where(
            and(
              eq(wodTemplates.id, id),
              eq(wodTemplates.ownerUserId, input.userId),
              eq(wodTemplates.body, body),
              stillOffered,
            ),
          ) as Stmt,
      )
    }

    stmts.push(
      this.db
        .delete(exerciseMuscles)
        .where(and(eq(exerciseMuscles.exerciseId, input.customExerciseId), stillOffered)) as Stmt,
    )
    stmts.push(
      this.db
        .delete(exercises)
        .where(and(eq(exercises.id, input.customExerciseId), stillOffered)) as Stmt,
    )

    stmts.push(
      this.db
        .update(exerciseSubmissions)
        .set({ migrationStatus: 'accepted', migratedAt: now })
        // Re-assert every precondition so a raced decline/double-accept
        // can't be clobbered by this terminal write.
        .where(
          and(
            eq(exerciseSubmissions.id, input.submissionId),
            eq(exerciseSubmissions.userId, input.userId),
            eq(exerciseSubmissions.status, 'approved'),
            eq(exerciseSubmissions.migrationStatus, 'offered'),
          ),
        ) as Stmt,
    )

    await this.db.batch(stmts as [Stmt, ...Stmt[]])

    return this.getById(input.submissionId)
  }
}
