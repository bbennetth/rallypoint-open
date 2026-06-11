import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { ledgers } from './ledgers.js'

// ledger_members — non-owner collaborators on a ledger (design doc §5).
// id is `lmm_<ulid>`. role is 'owner' | 'member' (the column allows
// both, but V1 only inserts 'member' rows — the owner is held by
// ledgers.owner_user_id and is implicit). user_id is a Rallypoint ID
// `user_<ulid>` (no cross-schema FK). Cascades on the parent ledger.
// (ledger_id, user_id) is unique — a user holds at most one membership
// row per ledger. user_idx drives "my ledgers I've been invited to."

export const ledgerMembers = sqliteTable(
  'ledger_members',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    // timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    ledgerUserIdx: uniqueIndex('money_ledger_members_ledger_user_uq').on(t.ledgerId, t.userId),
    userIdx: index('money_ledger_members_user_idx').on(t.userId),
  }),
)

export type DbLedgerMember = typeof ledgerMembers.$inferSelect
export type DbLedgerMemberInsert = typeof ledgerMembers.$inferInsert
