import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// workouts — a logged training session (NOT to be confused with the auth
// `sessions` table). The polymorphic spine of the "second brain": one row
// per training session of any modality, with per-set detail in
// workout_sets and modality-specific extras in the JSON `payload` (a WOD
// definition + result, run splits, a class name). id is `fs_<ulid>`.
//
// performed_at is the moment the session happened (user-set, may be
// backdated), indexed with user_id for the history/date-range reads.
// rpe is a session-level 1-10 perceived exertion. durationS is whole
// seconds. All optional fields are nullable so capture stays low-friction.
//
// ref is the **idempotency key** for offline create retries (mirrors
// money-db's expenses.ref): an offline client stamps a stable tmpId on a
// create op and replays it verbatim on retry, so re-sending the same
// (user_id, ref) returns the existing row instead of a duplicate. The
// partial-unique `(user_id, ref) WHERE ref IS NOT NULL` enforces it; rows
// without a ref are unconstrained.

export const workouts = sqliteTable(
  'workouts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    performedAt: integer('performed_at', { mode: 'timestamp_ms' }).notNull(),
    // strength | conditioning | endurance | class | mobility | mixed
    modality: text('modality').notNull(),
    title: text('title'),
    durationS: integer('duration_s'),
    location: text('location'),
    rpe: integer('rpe'),
    notes: text('notes'),
    // modality-specific JSON the app rarely queries field-by-field.
    payload: text('payload'),
    ref: text('ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userPerformedIdx: index('workouts_user_performed_idx').on(t.userId, t.performedAt),
    refUq: uniqueIndex('fitness_workouts_user_ref_uq')
      .on(t.userId, t.ref)
      .where(sql`${t.ref} IS NOT NULL`),
  }),
)

export type DbWorkout = typeof workouts.$inferSelect
export type DbWorkoutInsert = typeof workouts.$inferInsert
