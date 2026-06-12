import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, text, primaryKey } from 'drizzle-orm/sqlite-core'
import { listItems } from './list-items.js'
import { listLabels } from './list-labels.js'

// list_item_labels — join table for the many-to-many between items and
// labels (RPL v1.0.0 slice 12). No soft-delete: membership is managed
// by delete-then-insert in setItemLabels. The reverse (label_id) index
// drives labelsForItems batch lookup. created_at stamps the assignment
// for audit / ordering purposes; there is no updated_at on the join
// (row replace = delete + insert).
export const listItemLabels = sqliteTable(
  'list_item_labels',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => listItems.id, { onDelete: 'cascade' }),
    labelId: text('label_id')
      .notNull()
      .references(() => listLabels.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.itemId, t.labelId],
      name: 'list_item_labels_pkey',
    }),
    labelIdx: index('list_item_labels_label_idx').on(t.labelId),
  }),
)

export type DbListItemLabel = typeof listItemLabels.$inferSelect
export type DbListItemLabelInsert = typeof listItemLabels.$inferInsert
