import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// lineup_ingestions — one AI lineup-extraction run against a
// system-owned event, awaiting an admin's Approve/Reject decision
// (mirrors fitness's exercise_ai_reviews proposal pattern). Rows are
// created only by the admin-triggered ingest pipeline and never mutate
// the lineup on their own — approving a proposal goes through the same
// artists find-or-create + event_artists bulkApply path the lineup
// editor uses. id is `lin_<ulid>`.
//
// `extracted` holds the raw model JSON (audit); `proposal` holds the
// planLineupChanges output ({rows, deletes, errors, summary}) diffed
// against the lineup at ingest time. One PENDING ingestion per event at
// a time (partial unique index) — a re-ingest supersedes the open one
// instead of stacking proposals.

export const lineupIngestions = sqliteTable(
  'lineup_ingestions',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    // 'url' | 'pasted'
    sourceKind: text('source_kind').notNull(),
    sourceUrl: text('source_url'),
    // Truncated extracted page text the model saw (audit + hallucination
    // guard re-checks at approve time).
    sourceExcerpt: text('source_excerpt').notNull(),
    model: text('model').notNull(),
    // Raw model JSON (post-schema-validation), for audit/debugging.
    extracted: text('extracted').notNull(),
    // JSON: planLineupChanges output + extraction-level errors.
    proposal: text('proposal').notNull(),
    // pending | approved | rejected | superseded | failed
    status: text('status').notNull().default('pending'),
    error: text('error'),
    // @rallypoint/ai trace response id (links to ai-api's ai_traces).
    aiResponseId: text('ai_response_id'),
    createdBy: text('created_by').notNull(),
    reviewedBy: text('reviewed_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    eventIdx: index('lineup_ingestions_event_idx').on(t.eventId),
    statusIdx: index('lineup_ingestions_status_idx').on(t.status),
    pendingEventUq: uniqueIndex('lineup_ingestions_pending_event_uq')
      .on(t.eventId)
      .where(sql`${t.status} = 'pending'`),
  }),
)

export type DbLineupIngestion = typeof lineupIngestions.$inferSelect
export type DbLineupIngestionInsert = typeof lineupIngestions.$inferInsert
