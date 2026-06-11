import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { ledgers } from './ledgers.js'

// ledger_invites — single-use ledger invite (design doc §5). id is
// `lin_<ulid>`. code_hash = SHA-256('rpm_<base64url-256>') hex — the
// raw token leaves the API exactly once (create response). role is
// 'member' in V1 (column allows 'owner' for forward-compatibility —
// see ledger_members). invited_email nullable = open-code invite.
// 14-day TTL, single-use; consumed_at/consumed_by_user_id pin the
// acceptor. Cascades on the parent ledger.

export const ledgerInvites = sqliteTable(
  'ledger_invites',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    invitedByUserId: text('invited_by_user_id').notNull(),
    invitedEmail: text('invited_email'),
    role: text('role').notNull().default('member'),
    // timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    consumedByUserId: text('consumed_by_user_id'),
  },
  (t) => ({
    codeHashIdx: uniqueIndex('money_ledger_invites_code_hash_idx').on(t.codeHash),
    ledgerIdx: index('money_ledger_invites_ledger_idx').on(t.ledgerId),
  }),
)

export type DbLedgerInvite = typeof ledgerInvites.$inferSelect
export type DbLedgerInviteInsert = typeof ledgerInvites.$inferInsert
