import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// ledgers — the core Money primitive (design doc §5). id is a
// prefix-tagged ULID (`led_<ulid>`) minted in the app layer.
// owner_user_id holds a Rallypoint ID `user_<ulid>`; it is NOT a
// cross-schema FK (the schemas migrate independently).
//
// scope_type/scope_id is the group discriminator (locked scope
// decision 4): scope_type `group` references an Events `group_id`
// opaquely as text (no FK); scope_type `ledger_group` references a
// Money-local `ledger_groups` row (added in a later slice);
// scope_type `personal` is for single-owner use.
//
// currency is an ISO-4217 3-char code. One currency per ledger;
// multi-currency-per-ledger deferred to v2.
//
// deleted_at is the soft-delete marker; the pruner hard-purges 30
// days past it.

export const ledgers = sqliteTable(
  'ledgers',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    scopeType: text('scope_type').notNull(),
    scopeId: text('scope_id').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    description: text('description'),
    // timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    scopeIdx: index('money_ledgers_scope_idx').on(t.tenantId, t.scopeType, t.scopeId),
    ownerIdx: index('money_ledgers_owner_idx').on(t.ownerUserId),
  }),
)

export type DbLedger = typeof ledgers.$inferSelect
export type DbLedgerInsert = typeof ledgers.$inferInsert
