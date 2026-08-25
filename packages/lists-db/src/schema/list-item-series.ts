import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { lists } from './lists.js'

// Recurrence rule for a repeating task ("clean the bathroom every Sunday").
// A series is the parent; concrete occurrences are generated into
// `list_items` carrying `seriesId` + `occurrenceDate`. Rolling-window
// materialisation: open-ended series ("every Sunday") expand a bounded
// window on demand, capped per expansion (see lists-shared/recurrence.ts).
export const listItemSeries = sqliteTable(
  'list_item_series',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    // Template fields stamped onto each generated occurrence.
    title: text('title').notNull(),
    notes: text('notes'),
    assignedTo: text('assigned_to'),
    priority: text('priority'),
    // Recurrence rule (RFC-5545 subset): freq daily|weekly, interval >= 1,
    // byDay holds RFC-5545 BYDAY codes (MO,TU,...) for weekly, null otherwise.
    freq: text('freq').notNull(),
    interval: integer('interval').notNull().default(1),
    byDay: text('by_day', { mode: 'json' }).$type<string[]>(),
    // dtstart/until are plain calendar dates (ISO YYYY-MM-DD text);
    // timeOfDay (nullable, HH:MM:SS text) combines with the occurrence date
    // into each item's dueDate timestamp.
    dtstart: text('dtstart').notNull(),
    until: text('until'),
    count: integer('count'),
    timeOfDay: text('time_of_day'),
    // Opaque idempotency key for offline-retry-safe creates (mirrors
    // list_items.ref / money-db's expenses.ref). A create retried with
    // the same (list_id, ref) returns the original series row instead of
    // inserting a duplicate — see the partial-unique index below.
    ref: text('ref'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    listIdx: index('list_item_series_list_idx').on(t.listId),
    // Partial-unique on `(list_id, ref)` where ref is set — spans active +
    // soft-deleted rows so a tombstoned series' ref isn't silently
    // re-usable (mirrors list_items.refUq).
    refUq: uniqueIndex('lists_series_list_ref_uq')
      .on(t.listId, t.ref)
      .where(sql`${t.ref} IS NOT NULL`),
  }),
)

export type DbListItemSeries = typeof listItemSeries.$inferSelect
export type DbListItemSeriesInsert = typeof listItemSeries.$inferInsert
