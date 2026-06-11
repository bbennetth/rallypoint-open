import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { users } from './users.js'

// sessions — SQLite-backed session store. id_hash is
// SHA-256(token) (hex), the row PK. The raw rps_live_<token>
// never lives at rest; we hash inbound bearers/cookies and look
// the row up by digest.
//
// absolute_expires_at: hard ceiling on a session. Reset on
// rotation (signin / password change / email change / 2FA enable).
// last_seen_at: touched once per request via the LRU cache, not
// on every request — see middleware/session.ts.
//
// parent_session_id: session-family link for single-logout (#93).
// NULL for a top-level browser login. An SSO-minted consumer
// session (events/lists/money) points at the browser session that
// minted its code, so signing out of any family member can cascade
// to the whole family. Self-referential FK with onDelete cascade so
// deleting the parent row sweeps its children in the same statement.

export const sessions = sqliteTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    parentSessionId: text('parent_session_id').references(
      (): AnySQLiteColumn => sessions.idHash,
      { onDelete: 'cascade' },
    ),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    absoluteExpiresAt: integer('absolute_expires_at', { mode: 'timestamp_ms' }).notNull(),
    ipHash: text('ip_hash').notNull(),
    uaHash: text('ua_hash').notNull(),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    expiresIdx: index('sessions_expires_idx').on(t.absoluteExpiresAt),
    parentIdx: index('sessions_parent_idx').on(t.parentSessionId),
  }),
)

export type DbSession = typeof sessions.$inferSelect
export type DbSessionInsert = typeof sessions.$inferInsert
