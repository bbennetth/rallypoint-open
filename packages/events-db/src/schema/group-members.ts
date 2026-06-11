import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { groups } from './groups.js'

// group_members — group membership (design doc §5.5; renamed from
// `crew_members` in Phase R). id is `grm_<ulid>`. role is
// 'owner' | 'sidekick' | 'member'. user_id is a Rallypoint ID
// `user_<ulid>` (not FK'd). Cascades when the parent group is
// deleted. (group_id, user_id) is unique — a user holds at most one
// membership row per group.
//
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const groupMembers = sqliteTable(
  'group_members',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    groupUserIdx: uniqueIndex('group_members_group_user_idx').on(t.groupId, t.userId),
  }),
)

export type DbGroupMember = typeof groupMembers.$inferSelect
export type DbGroupMemberInsert = typeof groupMembers.$inferInsert
