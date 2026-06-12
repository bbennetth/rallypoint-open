import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, text } from 'drizzle-orm/sqlite-core'
import { lists } from './lists.js'

// list_labels — per-list, user-definable colored labels (RPL v1.0.0
// slice 12). Many-to-many with items via list_item_labels. id is a
// prefix-tagged ULID (`lbl_<ulid>`) minted in the app layer. position
// drives display order (append-at-end default). color is a free-form
// palette token owned by the UI (no strict regex, mirrors statusColorField).
// deleted_at is the soft-delete marker; join rows are hard-purged on
// soft-delete so labels stop appearing on items immediately.
export const listLabels = sqliteTable(
  'list_labels',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    position: integer('position').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    listIdx: index('list_labels_list_idx').on(t.listId, t.position),
  }),
)

export type DbListLabel = typeof listLabels.$inferSelect
export type DbListLabelInsert = typeof listLabels.$inferInsert
