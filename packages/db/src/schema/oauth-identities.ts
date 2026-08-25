import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from './users.js'

// oauth_identities — federated-identity links (social sign-in).
// One row per (user, external provider account). A user may link
// several providers, and — unlike auth_methods — several rows of the
// same kind are allowed (a Google AND a GitHub identity), so this is
// a dedicated table rather than an auth_methods.kind='oauth' overload
// (auth_methods has UNIQUE(user_id, kind) + a password-shaped
// secret_hash NOT NULL that does not fit a provider subject).
//
// `subject` is the provider's STABLE user id (OIDC `sub` / GitHub
// numeric id) — the join key, never the email (emails change). We
// snapshot the provider email + its verified flag at link time for
// display and auto-link decisions, but the join is always on
// (provider, subject).

export const oauthIdentities = sqliteTable(
  'oauth_identities',
  {
    id: text('id').primaryKey(), // ULID, no prefix
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    provider: text('provider').notNull(), // 'google' | 'apple' | 'github'
    subject: text('subject').notNull(),
    email: text('email'),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('oauth_identities_user_idx').on(t.userId),
    // The join key. A provider subject maps to exactly one Rallypoint
    // account per tenant; a second link attempt for the same
    // (provider, subject) trips this and is treated as "already
    // linked" by the callback.
    providerSubjectIdx: uniqueIndex('oauth_identities_provider_subject_idx').on(
      t.tenantId,
      t.provider,
      t.subject,
    ),
  }),
)
