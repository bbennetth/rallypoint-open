import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from './users.js'

// email_changes — in-flight email-change requests. token_hash =
// SHA-256(rpc_<token>) hex, PK. Stores both new_email and old_email
// so the cancel-from-old-address flow can show the user what
// they're cancelling. 24-hour TTL.

export const emailChanges = sqliteTable(
  'email_changes',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    newEmail: text('new_email').notNull(),
    oldEmail: text('old_email').notNull(),
    // Separate cancel_token_hash for the "click to cancel from old
    // email" flow. Lets us send a different opaque token to the old
    // address that doesn't disclose the confirm token.
    cancelTokenHash: text('cancel_token_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    cancelledAt: integer('cancelled_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('email_changes_user_idx').on(t.userId),
    // Unique per #36: the cancel token IS a bearer credential;
    // a duplicate-row situation should surface as a DB-level error
    // rather than ambiguous .limit(1) behavior.
    cancelIdx: uniqueIndex('email_changes_cancel_unique_idx').on(t.cancelTokenHash),
    expiresIdx: index('email_changes_expires_idx').on(t.expiresAt),
  }),
)

export type DbEmailChange = typeof emailChanges.$inferSelect
