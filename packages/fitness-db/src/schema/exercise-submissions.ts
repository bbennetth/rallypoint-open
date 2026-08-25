import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// exercise_submissions — a user's request to promote one of their private
// custom exercises into the curated global catalog. Reviewed by an admin
// (approve/reject); approval creates (or links to) a global `exercises`
// row and OFFERS the submitter a one-time migration of their logged
// history + favorites + machine settings onto the global row, which only
// runs if they accept (migration_status). id is `fsub_<ulid>`.
//
// Only one PENDING submission may exist per exercise at a time (the
// partial unique index below) — a second `submit` call while a review is
// in flight is a 409, not a duplicate row. Multiple past
// approved/rejected submissions for the same exercise are fine (e.g.
// resubmit after a rejection).

export const exerciseSubmissions = sqliteTable(
  'exercise_submissions',
  {
    id: text('id').primaryKey(),
    exerciseId: text('exercise_id').notNull(),
    userId: text('user_id').notNull(),
    // pending | approved | rejected
    status: text('status').notNull().default('pending'),
    adminNote: text('admin_note'),
    globalExerciseId: text('global_exercise_id'),
    // none | offered | accepted | declined
    migrationStatus: text('migration_status').notNull().default('none'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
    migratedAt: integer('migrated_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('exercise_submissions_user_idx').on(t.userId),
    statusIdx: index('exercise_submissions_status_idx').on(t.status),
    // At most one PENDING submission per exercise — guards the
    // double-submit race the same way exercises' per-owner name index
    // does. Not expressible with a simple column-set unique index since
    // it must exclude non-pending rows (a resubmit after rejection must
    // be allowed to create a new row).
    pendingExerciseUq: uniqueIndex('exercise_submissions_pending_exercise_uq')
      .on(t.exerciseId)
      .where(sql`${t.status} = 'pending'`),
  }),
)

export type DbExerciseSubmission = typeof exerciseSubmissions.$inferSelect
export type DbExerciseSubmissionInsert = typeof exerciseSubmissions.$inferInsert
