import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// exercise_ai_reviews — an AI-proposed muscle map for one global exercise,
// awaiting an admin's Apply/Dismiss decision. Rows are created only by the
// admin-triggered review pipeline (single exercise or catalog sweep) and
// never mutate the catalog on their own — applying a proposal goes through
// the same patch path an admin's manual edit uses. id is `fair_<ulid>`.
//
// proposed_muscles holds the JSON-encoded [{ muscleId, role }] array the
// model produced (validated against MUSCLE_IDS before insert). One PENDING
// review per exercise at a time (partial unique index) — a re-run while a
// proposal is open replaces the decision surface, not the row count.

export const exerciseAiReviews = sqliteTable(
  'exercise_ai_reviews',
  {
    id: text('id').primaryKey(),
    exerciseId: text('exercise_id').notNull(),
    // JSON [{ muscleId, role }]
    proposedMuscles: text('proposed_muscles').notNull(),
    rationale: text('rationale'),
    model: text('model').notNull(),
    // pending | applied | dismissed
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    exerciseIdx: index('exercise_ai_reviews_exercise_idx').on(t.exerciseId),
    statusIdx: index('exercise_ai_reviews_status_idx').on(t.status),
    pendingExerciseUq: uniqueIndex('exercise_ai_reviews_pending_exercise_uq')
      .on(t.exerciseId)
      .where(sql`${t.status} = 'pending'`),
  }),
)

export type DbExerciseAiReview = typeof exerciseAiReviews.$inferSelect
export type DbExerciseAiReviewInsert = typeof exerciseAiReviews.$inferInsert
