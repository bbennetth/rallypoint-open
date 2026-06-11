import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { ledgerGroups } from './ledger-groups.js'

// ledger_group_members — Money-local group membership (mirrors
// list_group_members). id is `lgm_<ulid>`. role is 'owner' |
// 'sidekick' | 'member'. user_id is a Rallypoint ID `user_<ulid>`
// (not FK'd). Cascades when the parent group is deleted. (group_id,
// user_id) is unique — a user holds at most one membership row per
// group. user_idx drives the "my groups" lookup.

export const ledgerGroupMembers = sqliteTable(
  'ledger_group_members',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => ledgerGroups.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    // timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    groupUserIdx: uniqueIndex('money_ledger_group_members_group_user_uq').on(t.groupId, t.userId),
    userIdx: index('money_ledger_group_members_user_idx').on(t.userId),
  }),
)

export type DbLedgerGroupMember = typeof ledgerGroupMembers.$inferSelect
export type DbLedgerGroupMemberInsert = typeof ledgerGroupMembers.$inferInsert
