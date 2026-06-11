import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { ledgers } from './ledgers.js'

// settlements — one party paying another to reduce an outstanding
// balance (design doc §5; formalises what festival-planner never
// modelled). id is `stl_<ulid>`. from_user_id and to_user_id are
// Rallypoint IDs `user_<ulid>` (no cross-schema FK). amount_cents is
// a non-negative integer (bigint to share the expense.total_cents
// shape). note is an optional one-line memo ("Venmo'd you"). settled_at
// is the calendar date of the payment stored as ISO YYYY-MM-DD text.
// created_by records who logged the row (not necessarily either party —
// any ledger member can log a payment on behalf of two parties; activity
// log captures the actor). Cascades on the parent ledger; no soft-delete
// column — settlements are a record of payment so an erroneous one is
// hard-deleted, the activity log retaining the create + delete pair.
//
// bigint('amount_cents') → integer(mode:'number'): SQLite INTEGER is
// 64-bit; integer-cents amounts stay well under 2^53, mode:'number' is safe.
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).
// date('settled_at') → text('settled_at') storing ISO YYYY-MM-DD.

export const settlements = sqliteTable(
  'settlements',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    fromUserId: text('from_user_id').notNull(),
    toUserId: text('to_user_id').notNull(),
    amountCents: integer('amount_cents', { mode: 'number' }).notNull(),
    note: text('note'),
    settledAt: text('settled_at').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    ledgerSettledIdx: index('money_settlements_ledger_settled_idx').on(
      t.ledgerId,
      t.settledAt,
    ),
  }),
)

export type DbSettlement = typeof settlements.$inferSelect
export type DbSettlementInsert = typeof settlements.$inferInsert
