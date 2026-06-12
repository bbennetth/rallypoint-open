import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, text } from 'drizzle-orm/sqlite-core'
import { listItems } from './list-items.js'

// list_item_comments — threaded comments on a list item (RPL v1.0.0
// slice 7). id is a prefix-tagged ULID (`lic_<ulid>`) minted in the
// app layer. item_id cascades on hard-delete of the parent item.
// author_id holds a Rallypoint ID `user_<ulid>` (not a cross-schema FK).
// body is the comment text (1–4000 chars, enforced app-side). deleted_at
// is the soft-delete marker; soft-deleted comments are hidden from reads
// but not hard-purged immediately (mirrors item soft-delete convention).
export const listItemComments = sqliteTable(
  'list_item_comments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    itemId: text('item_id')
      .notNull()
      .references(() => listItems.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    itemCreatedIdx: index('list_item_comments_item_idx').on(t.itemId, t.createdAt),
  }),
)

export type DbListItemComment = typeof listItemComments.$inferSelect
export type DbListItemCommentInsert = typeof listItemComments.$inferInsert
