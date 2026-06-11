import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { users } from './users.js'

// sso_codes — single-use cross-app SSO bootstrap token store.
// code_hash = SHA-256('rpsso_<base64url-256>') hex, PK.
// 60-second TTL (§3.13). consumed_at set when the events-api
// exchanges the code for a session; subsequent exchange attempts
// with the same code fail. Scoped by client ('events' in V1) and
// return_to_host (verified at exchange time). Rallypoint Events #57.
//
// minting_session_id_hash: the browser RPID session that minted the
// code (#93 single-logout). Carried through exchange so the issued
// consumer session records it as its parent_session_id, linking the
// session family. NULL only for codes minted before the column existed.

export const ssoCodes = sqliteTable(
  'sso_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mintingSessionIdHash: text('minting_session_id_hash'),
    client: text('client').notNull(),
    returnToHost: text('return_to_host').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userCreatedIdx: index('sso_codes_user_created_idx').on(t.userId, t.createdAt),
    expiresIdx: index('sso_codes_expires_idx').on(t.expiresAt),
  }),
)

export type DbSsoCode = typeof ssoCodes.$inferSelect
