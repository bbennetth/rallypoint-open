import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { users } from './users.js'

// webauthn_credentials — registered passkeys (WebAuthn). One row per
// credential; a user may register many (phone, laptop, security key),
// so this is a dedicated table, not an auth_methods.kind='passkey'
// overload (auth_methods' UNIQUE(user_id, kind) caps one-per-kind and
// its secret_hash column has no meaning for a public-key credential).
//
// `id` is the base64url credential id the authenticator returns — it is
// globally unique and is what an assertion carries, so it is the PK
// (authentication is usernameless/discoverable: we look the credential
// up by id, then read its user_id). `public_key` is the base64url of the
// stored COSE public-key bytes used to verify each assertion signature.
// `counter` is the authenticator sign-count for clone detection (many
// platform authenticators keep it at 0 — see verify-authentication).

export const webauthnCredentials = sqliteTable(
  'webauthn_credentials',
  {
    id: text('id').primaryKey(), // base64url credential id
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    publicKey: text('public_key').notNull(), // base64url COSE key bytes
    counter: integer('counter').notNull().default(0),
    transports: text('transports'), // JSON array e.g. ["internal","hybrid"]; nullable
    aaguid: text('aaguid'),
    backedUp: integer('backed_up', { mode: 'boolean' }),
    // User-editable device label ("iPhone", "YubiKey"). Defaulted from
    // the UA at registration; renamable in account settings.
    label: text('label').notNull().default('Passkey'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('webauthn_credentials_user_idx').on(t.userId),
  }),
)
