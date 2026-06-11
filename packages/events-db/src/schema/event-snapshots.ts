import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, text } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_snapshots — version history for the bulk-editable tabs (#191
// Phase 2). Before each destructive bulk apply (lineup or sessions) the
// API captures the current full set of rows for that entity into one
// snapshot row, so a bad edit can be reverted ("restore"). id is
// `esnap_<ulid>`.
//
// `kind` names the entity set the snapshot covers ('lineup' | 'sessions').
// `data` is the captured rows as a jsonb array (the repo Record shape at
// capture time). `reason` is a short human label for the list UI
// (e.g. 'before bulk lineup edit', 'before restore'). `item_count` is the
// denormalised row count so the history list need not parse `data`.
// Cascades when the parent event is hard-purged.
//
// jsonb('data') → text(mode:'json'): array of record objects.
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const eventSnapshots = sqliteTable(
  'event_snapshots',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    // jsonb('data') → text(mode:'json'): snapshot row array.
    data: text('data', { mode: 'json' })
      .notNull()
      .$type<unknown[]>(),
    reason: text('reason').notNull(),
    itemCount: integer('item_count').notNull().default(0),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    // Backs the history list query: newest-first within an (event, kind).
    eventKindIdx: index('event_snapshots_event_kind_idx').on(t.eventId, t.kind, t.createdAt),
  }),
)

export type DbEventSnapshot = typeof eventSnapshots.$inferSelect
export type DbEventSnapshotInsert = typeof eventSnapshots.$inferInsert
