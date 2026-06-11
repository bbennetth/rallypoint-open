import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { ledgers } from './ledgers.js'

// expense_categories — per-ledger spending taxonomy (design doc §5).
// id is `cat_<ulid>`. name is the human label ("Groceries"). color is
// a hex string `#RRGGBB` (rendered as chip background in the UI).
// sort_order drives explicit category ordering — drag-to-reorder
// updates this integer; ties broken by id for stability.
// (ledger_id, name) is unique so the UI can't end up with two
// "Groceries" chips on one ledger. Cascades on the parent ledger.
//
// Expenses reference categories via a `set-null` FK (next migration):
// deleting a category drops the linkage on its expenses but keeps
// the expenses themselves intact.

export const expenseCategories = sqliteTable(
  'expense_categories',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    // timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    ledgerNameUq: uniqueIndex('money_expense_categories_ledger_name_uq').on(
      t.ledgerId,
      t.name,
    ),
  }),
)

export type DbExpenseCategory = typeof expenseCategories.$inferSelect
export type DbExpenseCategoryInsert = typeof expenseCategories.$inferInsert
