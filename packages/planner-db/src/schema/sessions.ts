import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// sessions — planner-side session store (mirrors the events/lists/money
// sessions table; see events-v1 design doc §3.13). id_hash is SHA-256 of
// the planner session bearer handed to planner-web (the `__Host-rpp_session`
// cookie value). The RPID session bearer that planner-api replays to
// verifySession() CANNOT be hashed at rest, so it is stored
// AES-256-GCM encrypted: rpid_bearer_ciphertext + per-row 12-byte
// rpid_bearer_nonce + rpid_bearer_key_version (selects
// PLANNER_SESSION_KEY_V<n>). AAD binds the ciphertext to id_hash so a
// row's ciphertext cannot be lifted to another row.
//
// D1/SQLite has no binary column type, so the two ciphertext/nonce
// blobs are stored base64-encoded as text; the repo encodes on write
// and decodes back to a Buffer/Uint8Array on read (the AES-GCM crypto
// is unchanged). Mirrors packages/money-db/src/schema/sessions.ts and
// packages/lists-db/src/schema/sessions.ts.
//
// bytea → text (base64): rpid_bearer_ciphertext, rpid_bearer_nonce.
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const sessions = sqliteTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id').notNull(),
    rpidBearerCiphertext: text('rpid_bearer_ciphertext').notNull(),
    rpidBearerNonce: text('rpid_bearer_nonce').notNull(),
    rpidBearerKeyVersion: integer('rpid_bearer_key_version').notNull(),
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
    userIdx: index('planner_sessions_user_idx').on(t.userId),
    expiresIdx: index('planner_sessions_expires_idx').on(t.absoluteExpiresAt),
  }),
)

export type DbPlannerSession = typeof sessions.$inferSelect
export type DbPlannerSessionInsert = typeof sessions.$inferInsert
