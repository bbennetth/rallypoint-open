import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { users } from './users.js'

// email_verifications — stores SHA-256(rpv_<token>) as the
// primary key. The raw token only ever lives in the verification
// email; the server hashes the inbound token at /verify-email
// and looks up the row.
//
// 24-hour TTL; a single cron loop (slice 2.5) calls pruneExpired
// to reap consumed/expired rows.

export const emailVerifications = sqliteTable(
  'email_verifications',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    email: text('email').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('email_verifications_user_idx').on(t.userId),
    expiresIdx: index('email_verifications_expires_idx').on(t.expiresAt),
  }),
)

export type DbEmailVerification = typeof emailVerifications.$inferSelect
export type DbEmailVerificationInsert = typeof emailVerifications.$inferInsert
