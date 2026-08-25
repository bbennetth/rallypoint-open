import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { exercises } from './exercises.js'
import { muscles } from './muscles.js'

// exercise_muscles — many-to-many mapping from a catalog exercise to the
// muscles it works, with a role weighting (primary|secondary|stabilizer)
// that slice-4 volume aggregation uses (primary=1.0, secondary=0.5,
// stabilizer=0). Composite PK (exercise_id, muscle_id): a muscle appears at
// most once per exercise. Cascades from the exercise (deleting a custom
// exercise drops its maps); muscle_id has no cascade (the taxonomy is fixed
// reference data). cardio/gymnastics exercises may have zero rows here —
// that's fine; they still live in the one catalog so history stays unified.
//
// NOTE on FK enforcement: SQLite (and therefore D1) ships with
// `PRAGMA foreign_keys = OFF` by default — the declared FKs above
// are advisory metadata, not runtime guards. The real protection is at
// the route layer: the create-custom-exercise zod schema validates every
// `muscleId` against `MUSCLE_IDS`, and the catalog seed-integrity test
// guards the seed itself. A direct D1 console insert *could* slip an
// orphan past the FK; the application path cannot.

export const exerciseMuscles = sqliteTable(
  'exercise_muscles',
  {
    exerciseId: text('exercise_id')
      .notNull()
      .references(() => exercises.id, { onDelete: 'cascade' }),
    muscleId: text('muscle_id')
      .notNull()
      .references(() => muscles.id),
    role: text('role').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.exerciseId, t.muscleId] }),
    muscleIdx: index('exercise_muscles_muscle_idx').on(t.muscleId),
  }),
)

export type DbExerciseMuscle = typeof exerciseMuscles.$inferSelect
export type DbExerciseMuscleInsert = typeof exerciseMuscles.$inferInsert
