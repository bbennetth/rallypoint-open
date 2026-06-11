import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// ledger_groups — the Money-local group primitive (design doc §5,
// locked scope decision 4). A ledger with scope_type='ledger_group'
// references a row here via scope_id. id is `lgr_<ulid>`. created_by
// holds a Rallypoint ID `user_<ulid>` (not a cross-schema FK).
// Membership lives in ledger_group_members; the creator is
// auto-enrolled as 'owner' at create time. deleted_at is the
// soft-delete marker (pruner hard-purges 30 days past it, cascading
// members). Port of @rallypoint/lists-db's list_groups.

export const ledgerGroups = sqliteTable('ledger_groups', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().default('rallypoint'),
  name: text('name').notNull(),
  description: text('description'),
  createdBy: text('created_by').notNull(),
  // timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
})

export type DbLedgerGroup = typeof ledgerGroups.$inferSelect
export type DbLedgerGroupInsert = typeof ledgerGroups.$inferInsert
