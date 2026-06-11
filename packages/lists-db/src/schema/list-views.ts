import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, text } from 'drizzle-orm/sqlite-core'
import { lists } from './lists.js'

// list_views — saved filter/sort/columns/mode configurations for a list
// (Lists v2 slice 5). id is a prefix-tagged ULID (`lvw_<ulid>`) minted in
// the app layer. list_id is an intra-db FK that CASCADEs when its
// parent list is hard-purged. v2 views are per-list and SHARED (any list
// reader sees them; only the list creator edits) — a private "my view"
// (`owner_user_id`) is deferred.
//
// `config` is the opaque-to-the-DB JSON view spec (see
// @rallypoint/lists-shared ViewConfig: { filters, sort, visibleColumns,
// viewMode }). Stale specs inside it (a since-deleted field) are tolerated
// — resolved/dropped at apply time, mirroring slice 4. `position` orders
// the switcher; deleted_at soft-deletes the view.

export const listViews = sqliteTable(
  'list_views',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    config: text('config', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<{
        filters?: { field: string; op: string; value?: string }[]
        sort?: { field: string; dir: 'asc' | 'desc' }[]
        visibleColumns?: string[]
        viewMode?: 'list' | 'grid'
      }>(),
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
    listIdx: index('list_views_list_idx').on(t.listId, t.position),
  }),
)

export type DbListView = typeof listViews.$inferSelect
export type DbListViewInsert = typeof listViews.$inferInsert
