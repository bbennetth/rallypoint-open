import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// oauth_states — short-lived OAuth/OIDC authorization-request store, one
// row per in-flight social sign-in. Created in /oauth/:provider/start,
// consumed in the callback. Holds the PKCE code_verifier, the OIDC
// nonce, the post-login return_to, and (for "link a provider to my
// signed-in account") the link_user_id.
//
// state_hash = SHA-256(state token) hex, PK; the raw state travels in
// the provider round-trip and is re-hashed at the callback for lookup.
// browser_bind_hash = SHA-256(rp_oauth_bind cookie value): the callback
// requires the browser to still present the same bind cookie set at
// start, closing the login-CSRF hole that a server-only state check
// leaves open. markConsumed is the atomic single-use guard (like
// sso_codes). 10-minute TTL; the pruner reaps stragglers.

export const oauthStates = sqliteTable(
  'oauth_states',
  {
    stateHash: text('state_hash').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    provider: text('provider').notNull(), // 'google' | 'apple' | 'github'
    codeVerifier: text('code_verifier').notNull(),
    nonce: text('nonce').notNull(),
    returnTo: text('return_to').notNull(),
    // Set when the flow started from a signed-in "Connect account"
    // action — the callback links the identity to this user instead of
    // resolving/creating one. NULL for plain sign-in.
    linkUserId: text('link_user_id'),
    browserBindHash: text('browser_bind_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    expiresIdx: index('oauth_states_expires_idx').on(t.expiresAt),
  }),
)
