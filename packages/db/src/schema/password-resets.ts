import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { users } from './users.js'

// password_resets — single-use token store. token_hash =
// SHA-256(rpr_<token>) hex, PK. 1-hour TTL. consumed_at set when
// the new password is accepted; subsequent /confirm attempts with
// the same token fail.

export const passwordResets = sqliteTable(
  'password_resets',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('password_resets_user_idx').on(t.userId),
    expiresIdx: index('password_resets_expires_idx').on(t.expiresAt),
  }),
)

export type DbPasswordReset = typeof passwordResets.$inferSelect
