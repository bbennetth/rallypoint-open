import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, text } from 'drizzle-orm/sqlite-core'
import { listItemSeries } from './list-item-series.js'
import { lists } from './lists.js'

// list_items — the generic item primitive shared by all four list types
// (design resolution: one core item row, per-type extensions deferred to
// slices 3–6). id is a prefix-tagged ULID (`lit_<ulid>`) minted in the
// app layer. list_id is an intra-db FK that CASCADEs when its parent
// list is hard-purged. assigned_to holds a Rallypoint ID `user_<ulid>`
// (single owner; locked scope decision 4) and is NOT a cross-app FK.
//
// completed/completed_at is the generic check-off state (the app stamps
// completed_at when completed flips true and clears it when it flips
// false). position is a per-list integer ordering (append = max+1);
// reorder is a position PATCH, mirroring the Events nested-CRUD
// convention. deleted_at is the soft-delete marker; the pruner
// hard-purges 30 days past it.
//
// status/priority/due_date are the task-type extension columns (slice 3,
// ported from festival-planner). They are nullable because only `tasks`
// lists populate them; other list types leave them NULL. For a task list
// `status` ('todo'|'in_progress'|'done') is the source of truth and the
// app mirrors completed/completed_at off it (done ⟺ completed). The enums
// live in the app layer (no DB check constraint), matching the
// text-not-enum precedent of lists.list_type / lists.visibility.

export const listItems = sqliteTable(
  'list_items',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    notes: text('notes'),
    assignedTo: text('assigned_to'),
    completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    status: text('status'),
    priority: text('priority'),
    dueDate: integer('due_date', { mode: 'timestamp_ms' }),
    // Recurrence linkage (slice 1). A generated occurrence carries the
    // parent series id (FK set-null so deleting the series orphans rather
    // than cascades) plus its occurrenceDate — the calendar date the rule
    // expanded to (ISO YYYY-MM-DD text). (seriesId, occurrenceDate) is the
    // idempotency key for re-projection: a soft-deleted occurrence row acts
    // as an EXDATE so a re-expand won't resurrect it. isException marks an
    // occurrence the user detached/edited in place — re-projection must not
    // overwrite it.
    seriesId: text('series_id').references(() => listItemSeries.id, {
      onDelete: 'set null',
    }),
    occurrenceDate: text('occurrence_date'),
    isException: integer('is_exception', { mode: 'boolean' }).notNull().default(false),
    position: integer('position').notNull().default(0),
    // Lists v2 custom field values, keyed by list_field_defs.id. Inert on
    // a list with no field defs (defaults to `{}`), so v1 behaviour is
    // unchanged. Stored as JSON text; the `has_any` containment filter is
    // evaluated via json_each / app-side rather than a GIN index (D1 has
    // no GIN).
    customFields: text('custom_fields', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
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
    listIdx: index('list_items_list_idx').on(t.listId, t.position),
    assignedIdx: index('list_items_assigned_idx').on(t.assignedTo),
    statusIdx: index('list_items_status_idx').on(t.listId, t.status),
    seriesIdx: index('list_items_series_idx').on(t.seriesId, t.occurrenceDate),
  }),
)

export type DbListItem = typeof listItems.$inferSelect
export type DbListItemInsert = typeof listItems.$inferInsert
