import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { lists } from './lists.js'

// list_shares — who has read access to a `visibility='private'` list
// beyond the creator. The creator is implicit (lists.created_by); rows
// here are the people they've explicitly shared the list with via the
// share-by-email flow (#128). The unique index keeps a user from being
// shared the same list twice.
//
// id is a prefix-tagged ULID (`lsh_<ulid>`) minted in the app layer.
// `added_by_user_id` records who created the share row — usually
// equals the list's creator, but we keep it explicit so future "list
// manager" roles can share without losing audit fidelity.

export const listShares = sqliteTable(
  'list_shares',
  {
    id: text('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    addedByUserId: text('added_by_user_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    listUserIdx: uniqueIndex('list_shares_list_user_idx').on(t.listId, t.userId),
  }),
)

export type DbListShare = typeof listShares.$inferSelect
export type DbListShareInsert = typeof listShares.$inferInsert
