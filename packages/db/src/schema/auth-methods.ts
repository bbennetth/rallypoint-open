import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from './users.js'

// auth_methods — join table from V1. V1 only writes
// `kind = 'password'`; the schema accommodates passkeys, TOTP,
// and SMS (Phase B) without migration.
//
// secret_hash is the argon2id digest for kind='password'.
// key_version selects which pepper was applied at hash time so we
// can rotate the pepper without a flag day.

export const authMethods = sqliteTable(
  'auth_methods',
  {
    id: text('id').primaryKey(), // ULID, no prefix
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    kind: text('kind').notNull(), // 'password' in V1
    secretHash: text('secret_hash').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('auth_methods_user_idx').on(t.userId),
    // Unique per #37: the application logic assumes one row per
    // (user, kind). Without this, a race that creates two password
    // rows for the same user would silently let updateSecret rotate
    // the WRONG row, leaving the user locked out.
    userKindIdx: uniqueIndex('auth_methods_user_kind_unique_idx').on(t.userId, t.kind),
  }),
)

export type DbAuthMethod = typeof authMethods.$inferSelect
export type DbAuthMethodInsert = typeof authMethods.$inferInsert
