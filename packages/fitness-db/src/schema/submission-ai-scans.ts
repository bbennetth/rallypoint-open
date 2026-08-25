import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// submission_ai_scans — an automatic AI triage pass over one incoming
// admin-review submission (an exercise_submissions or food_submissions
// row, discriminated by subject_type). Rows are advisory only: they
// carry a verdict + findings badge for the admin queues and never
// mutate the submission or the catalog. id is `fscan_<ulid>`.
//
// findings holds the JSON-encoded array of { dimension, severity,
// message, ... } objects the model produced (validated against
// scanFindingsSchema before insert). One PENDING scan per subject at a
// time (partial unique index) — the fire-on-write trigger, the lazy
// list backstop, and the admin Re-scan button all race through it
// safely. History is kept: a re-scan adds a new row; readers take the
// latest per subject.

export const submissionAiScans = sqliteTable(
  'submission_ai_scans',
  {
    id: text('id').primaryKey(),
    // 'exercise' | 'food'
    subjectType: text('subject_type').notNull(),
    // fsub_* / fdsub_* submission id
    subjectId: text('subject_id').notNull(),
    // pending | done | failed
    status: text('status').notNull().default('pending'),
    // ok | warn | flag — null until done
    verdict: text('verdict'),
    // JSON [{ dimension, severity, message, suggestedName?, suggestedBrand?, duplicateId? }]
    findings: text('findings'),
    model: text('model').notNull(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    subjectIdx: index('submission_ai_scans_subject_idx').on(
      t.subjectType,
      t.subjectId,
      t.createdAt,
    ),
    statusIdx: index('submission_ai_scans_status_idx').on(t.status),
    pendingSubjectUq: uniqueIndex('submission_ai_scans_pending_subject_uq')
      .on(t.subjectType, t.subjectId)
      .where(sql`${t.status} = 'pending'`),
  }),
)

export type DbSubmissionAiScan = typeof submissionAiScans.$inferSelect
export type DbSubmissionAiScanInsert = typeof submissionAiScans.$inferInsert
