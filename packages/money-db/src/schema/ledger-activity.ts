import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { ledgers } from './ledgers.js'

// ledger_activity — owner-facing, ledger-scoped activity log
// (design doc §5; parity with events event_activity). id is
// `lac_<ulid>`. Distinct from RPID's operator `audit_log`: this
// lives in money_v1, cascades on hard-purge, and is read by the
// ledger's owner. event_type covers ledger lifecycle + membership +
// invites + ledger-group events; meta carries a no-secrets summary.
// The one event that must OUTLIVE the row —
// 'ledger.hard_deleted' — belongs to the operator store.

export const ledgerActivity = sqliteTable(
  'ledger_activity',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').notNull(),
    eventType: text('event_type').notNull(),
    // jsonb({}) → text(mode:'json') with sql`'{}'` default.
    meta: text('meta', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    // timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    ledgerCreatedIdx: index('money_ledger_activity_ledger_created_idx').on(t.ledgerId, t.createdAt),
  }),
)

export type DbLedgerActivity = typeof ledgerActivity.$inferSelect
export type DbLedgerActivityInsert = typeof ledgerActivity.$inferInsert
