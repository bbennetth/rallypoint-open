import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { aiTraces } from './traces.js'

// ai_feedback — what the user did with a model response: the label set for
// future eval/tuning work. One row per user action, keyed to the trace row
// (response) it judges.
//
//   action           — accepted | edited | rejected | retried.
//   final_value_json — for edits, the value the user actually landed on.
//                      Forced NULL server-side when the parent trace has
//                      content_omitted=1 (opt-out suppresses content, never
//                      the action itself).

export const aiFeedback = sqliteTable(
  'ai_feedback',
  {
    id: text('id').primaryKey(),
    responseId: text('response_id')
      .notNull()
      .references(() => aiTraces.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    action: text('action', { enum: ['accepted', 'edited', 'rejected', 'retried'] }).notNull(),
    finalValueJson: text('final_value_json'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userIdx: index('ai_feedback_user_idx').on(t.userId),
    responseIdx: index('ai_feedback_response_idx').on(t.responseId),
  }),
)

export type DbAiFeedback = typeof aiFeedback.$inferSelect
export type DbAiFeedbackInsert = typeof aiFeedback.$inferInsert
