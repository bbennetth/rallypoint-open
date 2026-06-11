import { sql } from 'drizzle-orm'
import { sqliteTable, index, text, integer } from 'drizzle-orm/sqlite-core'
import { groups } from './groups.js'

// chat_messages — group chat (Slice 10, #72). id is `msg_<ulid>`. Lives
// under a group (CASCADE) so deleting a group clears its messages. user_id
// is a Rallypoint ID `user_<ulid>` (not FK'd — cross-schema). body is the
// message text. created_at is a real timestamptz instant. Index on
// (group_id, created_at) backs the per-group reverse-chron pagination.
//
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    groupCreatedIdx: index('chat_messages_group_created_idx').on(t.groupId, t.createdAt),
  }),
)

export type DbChatMessage = typeof chatMessages.$inferSelect
export type DbChatMessageInsert = typeof chatMessages.$inferInsert
