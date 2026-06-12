import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, text } from 'drizzle-orm/sqlite-core'
import { lists } from './lists.js'

// list_statuses — per-list, user-definable workflow states (RPL v1.0.0
// slice 1). Replaces the hard-coded todo/in_progress/done enum that
// previously lived only in the app layer. id is a prefix-tagged ULID
// (`lst_<ulid>`) minted in the app layer.
//
// `category` is the load-bearing column: completion semantics (done ⟺
// completed), kanban column grouping, GitHub PR auto-done, and release
// auto-close all key off the category (`todo`|`in_progress`|`done`), NOT
// the renameable `name`. A list always keeps at least one done-category
// status so "complete" stays expressible. `color` mirrors the v2 custom-
// field choice palette (hex string).
//
// Statuses are seeded lazily: the first read for a list with no rows
// inserts the three defaults (see lists-shared/statuses.ts). The legacy
// `list_items.status` text column is dual-written with the category slug
// through v1 so old isolates keep working mid-rollout; dropping it is a
// post-launch contract migration.
export const listStatuses = sqliteTable(
  'list_statuses',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    category: text('category').notNull(),
    position: integer('position').notNull().default(0),
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
    listIdx: index('list_statuses_list_idx').on(t.listId, t.position),
  }),
)

export type DbListStatus = typeof listStatuses.$inferSelect
export type DbListStatusInsert = typeof listStatuses.$inferInsert
