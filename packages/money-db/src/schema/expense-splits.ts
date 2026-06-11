import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'
import { expenses } from './expenses.js'

// expense_splits — one row per participant in an expense (design doc
// §5). `amount_cents` is set for split_mode='by_amount' (and must sum
// to the parent total); `share_weight` is set for split_mode='by_share'
// (largest-remainder rounded at resolution time); both are null for
// split_mode='equal'. The mode itself is denormalised onto
// expenses.split_mode for query clarity (see §6).
//
// user_id is a Rallypoint ID `user_<ulid>` (not FK'd). Cascades when
// the parent expense is hard-deleted. PK on (expense_id, user_id) so
// the same user can't have two split rows for one expense.
//
// bigint('amount_cents') → integer(mode:'number'): SQLite INTEGER is
// 64-bit; integer-cents amounts stay well under 2^53, mode:'number' is safe.

export const expenseSplits = sqliteTable(
  'expense_splits',
  {
    expenseId: text('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    amountCents: integer('amount_cents', { mode: 'number' }),
    shareWeight: integer('share_weight'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.expenseId, t.userId] }),
  }),
)

export type DbExpenseSplit = typeof expenseSplits.$inferSelect
export type DbExpenseSplitInsert = typeof expenseSplits.$inferInsert
