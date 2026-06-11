import { sql } from 'drizzle-orm'
import { sqliteTable, index, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { listGroups } from './list-groups.js'

// list_group_members — group membership (mirrors Events group_members).
// id is `lgm_<ulid>`. role is 'owner' | 'sidekick' | 'member'. user_id
// is a Rallypoint ID `user_<ulid>` (not FK'd). Cascades when the parent
// group is deleted. (group_id, user_id) is unique — a user holds at most
// one membership row per group. The user_idx drives the "my groups"
// lookup (groups I belong to).

export const listGroupMembers = sqliteTable(
  'list_group_members',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => listGroups.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    groupUserIdx: uniqueIndex('list_group_members_group_user_uq').on(t.groupId, t.userId),
    userIdx: index('list_group_members_user_idx').on(t.userId),
  }),
)

export type DbListGroupMember = typeof listGroupMembers.$inferSelect
export type DbListGroupMemberInsert = typeof listGroupMembers.$inferInsert
