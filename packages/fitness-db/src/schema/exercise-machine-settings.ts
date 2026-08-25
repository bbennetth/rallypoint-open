import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// exercise_machine_settings — per-user, per-exercise flexible name/value
// notes (e.g. "Cable height" -> "4", "Handle" -> "rope"). Mirrors
// exercise_favorites' shape: a thin join-key table keyed by
// (user_id, exercise_id), one row per pair. `entries` stores the
// name/value list as JSON text (validated by
// machineSettingsEntriesSchema in @rallypoint/fitness-shared before it
// ever reaches the DB) rather than a child table — the list is small
// (max 12 entries) and always read/written as a whole, so a normalized
// table would just add joins with no query benefit.
//
// Saving an empty entries array deletes the row entirely (repo-level
// contract) so "no machine settings" has one representation, not two.

export const exerciseMachineSettings = sqliteTable(
  'exercise_machine_settings',
  {
    userId: text('user_id').notNull(),
    exerciseId: text('exercise_id').notNull(),
    entries: text('entries').notNull().default('[]'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.exerciseId] }),
    exerciseIdx: index('exercise_machine_settings_exercise_idx').on(t.exerciseId),
  }),
)

export type DbExerciseMachineSettings = typeof exerciseMachineSettings.$inferSelect
export type DbExerciseMachineSettingsInsert = typeof exerciseMachineSettings.$inferInsert
