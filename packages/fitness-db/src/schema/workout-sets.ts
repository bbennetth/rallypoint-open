import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { exercises } from './exercises.js'
import { workouts } from './workouts.js'

// workout_sets — the per-set detail of a workout. Each row references a
// catalog exercise and carries whichever result fields its metric_shape
// implies (load_reps → reps + load_kg; distance_time → distance_m + time_s;
// rounds_reps → rounds + reps; duration → time_s). Stored in SI units
// (kg, metres, seconds); the UI converts for display. set_index orders
// rows within a workout; consecutive rows sharing an exercise_id are the
// "sets" of that movement (the UI groups them). id is `fset_<ulid>`.
//
// Cascades from the workout (deleting a workout drops its sets). exercise_id
// references the catalog with NO cascade — exercises are reference data and
// are not deleted out from under logged history in V1.

export const workoutSets = sqliteTable(
  'workout_sets',
  {
    id: text('id').primaryKey(),
    workoutId: text('workout_id')
      .notNull()
      .references(() => workouts.id, { onDelete: 'cascade' }),
    exerciseId: text('exercise_id')
      .notNull()
      .references(() => exercises.id),
    setIndex: integer('set_index').notNull().default(0),
    reps: integer('reps'),
    loadKg: real('load_kg'),
    calories: integer('calories'),
    distanceM: real('distance_m'),
    timeS: real('time_s'),
    inclinePct: real('incline_pct'),
    rounds: integer('rounds'),
    rpe: integer('rpe'),
    notes: text('notes'),
    setType: text('set_type').notNull().default('working'),
  },
  (t) => ({
    workoutIdx: index('workout_sets_workout_idx').on(t.workoutId),
    exerciseIdx: index('workout_sets_exercise_idx').on(t.exerciseId),
  }),
)

export type DbWorkoutSet = typeof workoutSets.$inferSelect
export type DbWorkoutSetInsert = typeof workoutSets.$inferInsert
