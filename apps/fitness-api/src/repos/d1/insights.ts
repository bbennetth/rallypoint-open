import { and, eq, gte, lt } from 'drizzle-orm'
import { exercises, exerciseMuscles, workouts, workoutSets } from '@rallypoint/fitness-db'
import type {
  VolumeSetInput,
  WeeklySetInput,
  PrSetInput,
  ExerciseHistorySetRow,
} from '@rallypoint/fitness-shared'
import type { InsightsRepo } from '../types.js'
import type { Db } from './db.js'

// D1InsightsRepo — slice-4 derived training insights.
// Both methods use LEFT/INNER JOINs in a single query to avoid a second
// inArray() that would blow D1's ~100 bound-parameter cap.

export class D1InsightsRepo implements InsightsRepo {
  constructor(private readonly db: Db) {}

  // Pull every set in the window + its exercise_muscles entries in one flat
  // LEFT JOIN query, then group in JS. Each distinct set_id becomes one
  // VolumeSetInput whose muscles[] may be empty (cardio / gymnastics with
  // no muscle maps).
  async volumeSets(userId: string, fromMs: number, toMs: number): Promise<VolumeSetInput[]> {
    const fromDate = new Date(fromMs)
    const toDate = new Date(toMs)

    const rows = await this.db
      .select({
        setId: workoutSets.id,
        reps: workoutSets.reps,
        loadKg: workoutSets.loadKg,
        muscleId: exerciseMuscles.muscleId,
        role: exerciseMuscles.role,
      })
      .from(workoutSets)
      .innerJoin(workouts, eq(workouts.id, workoutSets.workoutId))
      .leftJoin(exerciseMuscles, eq(exerciseMuscles.exerciseId, workoutSets.exerciseId))
      .where(
        and(
          eq(workouts.userId, userId),
          gte(workouts.performedAt, fromDate),
          // Half-open `[from, to)` matches the UI's local-day windowing
          // (windowToRange returns local-midnight-of-tomorrow as `to`).
          lt(workouts.performedAt, toDate),
          // Warmup sets never count toward volume.
          eq(workoutSets.setType, 'working'),
        ),
      )

    // Group in JS: one VolumeSetInput per distinct set id.
    const orderSeen: string[] = []
    const bySetId = new Map<
      string,
      { reps: number | null; loadKg: number | null; muscles: { muscleId: string; role: string }[] }
    >()

    for (const row of rows) {
      let entry = bySetId.get(row.setId)
      if (!entry) {
        entry = { reps: row.reps, loadKg: row.loadKg, muscles: [] }
        bySetId.set(row.setId, entry)
        orderSeen.push(row.setId)
      }
      // muscleId is null when LEFT JOIN found no exercise_muscles row.
      if (row.muscleId != null && row.role != null) {
        entry.muscles.push({ muscleId: row.muscleId, role: row.role })
      }
    }

    return orderSeen.map((id) => {
      const e = bySetId.get(id)!
      return { reps: e.reps, loadKg: e.loadKg, muscles: e.muscles }
    })
  }

  // Working sets in the window with just what total tonnage needs — no
  // muscle join (which would fan rows out per muscle), so this stays one
  // narrow scan over the (userId, performedAt) index. Same half-open
  // window + warmup exclusion as volumeSets.
  async weeklyVolumeSets(
    userId: string,
    fromMs: number,
    toMs: number,
  ): Promise<WeeklySetInput[]> {
    const rows = await this.db
      .select({
        performedAt: workouts.performedAt,
        reps: workoutSets.reps,
        loadKg: workoutSets.loadKg,
      })
      .from(workoutSets)
      .innerJoin(workouts, eq(workouts.id, workoutSets.workoutId))
      .where(
        and(
          eq(workouts.userId, userId),
          gte(workouts.performedAt, new Date(fromMs)),
          lt(workouts.performedAt, new Date(toMs)),
          eq(workoutSets.setType, 'working'),
        ),
      )

    return rows.map((r) => ({
      performedAtMs:
        r.performedAt instanceof Date
          ? r.performedAt.getTime()
          : new Date(r.performedAt as unknown as number).getTime(),
      reps: r.reps,
      loadKg: r.loadKg,
    }))
  }

  // Pull every set for this user, joined to the exercise name, in one flat
  // INNER JOIN query, then group in JS by exercise_id.
  //
  // No LIMIT and no time-window: PR detection has to consider the user's
  // full lifetime history (e.g. a 5RM from 18 months ago is still a PR).
  // D1 scans are roughly 1µs/row; 10k sets ≈ 10ms — comfortable for a
  // personal-use app. Revisit (windowed pre-aggregation table) if a user
  // ever crosses ~100k sets.
  async prSetsByExercise(
    userId: string,
  ): Promise<{ exerciseId: string; exerciseName: string; sets: PrSetInput[] }[]> {
    const rows = await this.db
      .select({
        exerciseId: workoutSets.exerciseId,
        exerciseName: exercises.name,
        reps: workoutSets.reps,
        loadKg: workoutSets.loadKg,
        distanceM: workoutSets.distanceM,
        timeS: workoutSets.timeS,
        performedAt: workouts.performedAt,
      })
      .from(workoutSets)
      .innerJoin(workouts, eq(workouts.id, workoutSets.workoutId))
      .innerJoin(exercises, eq(exercises.id, workoutSets.exerciseId))
      .where(and(eq(workouts.userId, userId), eq(workoutSets.setType, 'working')))

    // Group by exerciseId in JS, preserving first-seen order for stable output.
    const order: string[] = []
    const byExId = new Map<
      string,
      { exerciseId: string; exerciseName: string; sets: PrSetInput[] }
    >()

    for (const row of rows) {
      let entry = byExId.get(row.exerciseId)
      if (!entry) {
        entry = { exerciseId: row.exerciseId, exerciseName: row.exerciseName, sets: [] }
        byExId.set(row.exerciseId, entry)
        order.push(row.exerciseId)
      }
      entry.sets.push({
        reps: row.reps,
        loadKg: row.loadKg,
        distanceM: row.distanceM,
        timeS: row.timeS,
        performedAt: row.performedAt instanceof Date
          ? row.performedAt.toISOString()
          : new Date(row.performedAt as unknown as number).toISOString(),
      })
    }

    return order.map((id) => byExId.get(id)!)
  }

  // Every working set this user has logged for ONE exercise, joined to its
  // workout (title + performedAt). Scoped like prSetsByExercise but far
  // narrower — one exercise's sets — so the full scan is cheap. Grouping
  // into recent sessions + capping happens at the route via the pure
  // groupExerciseHistory helper. Warmups are excluded (they're not
  // "how much did I do last time" data).
  async recentSetsForExercise(
    userId: string,
    exerciseId: string,
  ): Promise<ExerciseHistorySetRow[]> {
    const rows = await this.db
      .select({
        workoutId: workoutSets.workoutId,
        workoutTitle: workouts.title,
        performedAt: workouts.performedAt,
        setIndex: workoutSets.setIndex,
        reps: workoutSets.reps,
        loadKg: workoutSets.loadKg,
        rpe: workoutSets.rpe,
      })
      .from(workoutSets)
      .innerJoin(workouts, eq(workouts.id, workoutSets.workoutId))
      .where(
        and(
          eq(workouts.userId, userId),
          eq(workoutSets.exerciseId, exerciseId),
          eq(workoutSets.setType, 'working'),
        ),
      )

    return rows.map((r) => ({
      workoutId: r.workoutId,
      workoutTitle: r.workoutTitle,
      performedAt:
        r.performedAt instanceof Date
          ? r.performedAt.toISOString()
          : new Date(r.performedAt as unknown as number).toISOString(),
      setIndex: r.setIndex,
      reps: r.reps,
      loadKg: r.loadKg,
      rpe: r.rpe,
    }))
  }
}
