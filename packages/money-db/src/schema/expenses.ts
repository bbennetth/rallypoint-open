import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { ledgers } from './ledgers.js'
import { expenseCategories } from './expense-categories.js'

// expenses — the core posting unit (design doc §5). id is `exp_<ulid>`.
// total_cents is an integer cents amount (integer in SQLite — 64-bit, fits
// well within Number.MAX_SAFE_INTEGER for all real ledger sizes).
// paid_by_user_id and created_by hold Rallypoint IDs (not cross-schema
// FKs). split_mode is 'equal' | 'by_share' | 'by_amount' — validated
// by the @rallypoint/money-shared zod enum, denormalised here for
// query-time clarity and to gate the resolver. spent_at is a calendar
// date stored as ISO YYYY-MM-DD text (no time-of-day in V1).
// deleted_at is the soft-delete marker (pruner hard-purges 30 days
// past it, cascading splits).
//
// category_id is a same-schema FK to expense_categories with onDelete:
// 'set null' (design doc §5) — deleting a category drops the linkage
// on its expenses but keeps the expenses themselves intact.
//
// ref is the **idempotency key** for upstream cascades (design §5/§7):
// when a caller (e.g. a future Lists→Money cascade) re-posts the same
// expense, supplying the same ref keeps creation at-most-once per
// ledger. The partial-unique `(ledger_id, ref) WHERE ref IS NOT NULL`
// enforces it; rows without a ref are unconstrained.
//
// receipt_* (slice 7): nullable trio holding the S3-compatible object
// pointer for an optional receipt image. object_key is reconstructed
// server-side from trusted ids; content_type + bytes are HEAD-validated
// post-upload (design §2/§5).
//
// bigint('total_cents'/'receipt_bytes') → integer(mode:'number'): SQLite
// INTEGER is 64-bit; these are integer-cents amounts that stay well under
// 2^53, so mode:'number' is safe (no float risk).
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).
// date('spent_at') → text('spent_at') storing ISO YYYY-MM-DD.

export const expenses = sqliteTable(
  'expenses',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    paidByUserId: text('paid_by_user_id').notNull(),
    totalCents: integer('total_cents', { mode: 'number' }).notNull(),
    description: text('description').notNull(),
    splitMode: text('split_mode').notNull(),
    categoryId: text('category_id').references(() => expenseCategories.id, {
      onDelete: 'set null',
    }),
    ref: text('ref'),
    receiptObjectKey: text('receipt_object_key'),
    receiptContentType: text('receipt_content_type'),
    receiptBytes: integer('receipt_bytes', { mode: 'number' }),
    spentAt: text('spent_at').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    // Drives the ledger-detail feed (active expenses for a ledger,
    // newest-spent first).
    ledgerSpentIdx: index('money_expenses_ledger_spent_idx').on(
      t.ledgerId,
      t.spentAt,
    ),
    // Partial-unique on `(ledger_id, ref)` where ref is set — the
    // idempotency key for upstream cascades. Spans active +
    // soft-deleted rows so a tombstoned expense's ref isn't
    // silently re-usable.
    // Note: SQLite partial indexes (.where()) are supported by drizzle-kit
    // for D1 generation.
    ledgerRefUq: uniqueIndex('money_expenses_ledger_ref_uq')
      .on(t.ledgerId, t.ref)
      .where(sql`${t.ref} IS NOT NULL`),
  }),
)

export type DbExpense = typeof expenses.$inferSelect
export type DbExpenseInsert = typeof expenses.$inferInsert
