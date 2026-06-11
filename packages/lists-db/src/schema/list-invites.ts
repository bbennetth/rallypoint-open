import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { lists } from './lists.js'

// list_invites — pending share-by-email invites for `visibility='private'`
// lists (#128). The API mints a row + raw code; the raw code is
// returned exactly once and never re-derivable. Accepting an invite
// adds a list_shares row for the consumer + marks this row consumed.
// Mirrors the events-api invites table shape (event_invites).
//
// id is a prefix-tagged ULID (`lin_<ulid>`). code_hash is sha256 of
// the raw code; consumed_at / consumed_by_user_id are set at accept
// time. expires_at defaults 14d out at create (enforced in the route).

export const listInvites = sqliteTable(
  'list_invites',
  {
    id: text('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    invitedByUserId: text('invited_by_user_id').notNull(),
    invitedEmail: text('invited_email').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    consumedByUserId: text('consumed_by_user_id'),
  },
  (t) => ({
    codeHashIdx: uniqueIndex('list_invites_code_hash_idx').on(t.codeHash),
    listIdx: index('list_invites_list_idx').on(t.listId),
  }),
)

export type DbListInvite = typeof listInvites.$inferSelect
export type DbListInviteInsert = typeof listInvites.$inferInsert
