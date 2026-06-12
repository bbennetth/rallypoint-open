import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// mcp_tokens — personal access tokens for the Rallypoint Lists MCP server
// (RPL v1.0.0 slice 11). A user mints a token in lists-web settings; the
// raw value (`rplmcp_<base64url>`) is shown once and never stored — only
// its SHA-256 (`id_hash`) is kept, mirroring the sessions/invites
// hash-at-rest pattern. The `apps/lists-mcp` Worker presents the raw token
// as a bearer; lists-api hashes the inbound value, looks the row up here,
// and resolves it to `user_id`, which becomes the `x-actor` for the SDK
// calls the MCP server makes on the user's behalf.
//
// `id` is a stable, non-secret identifier for listing/revoking tokens in
// the UI (the hash is never surfaced). Revocation is a soft `revoked_at`
// stamp so a revoked token's audit row survives; lookups treat a revoked
// or expired row as invalid.

export const mcpTokens = sqliteTable(
  'mcp_tokens',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    // SHA-256 hex of the raw token; the lookup key. Unique so a hash
    // collision (or a re-insert) can't shadow another user's token.
    idHash: text('id_hash').notNull().unique(),
    userId: text('user_id').notNull(),
    // User-given name so multiple tokens (laptop, CI, etc.) are tellable apart.
    label: text('label').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    // Stamped on each successful resolve so the UI can show "last used".
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    // Optional expiry; null = non-expiring.
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    // Soft-revoke marker; a non-null value makes the token invalid.
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('mcp_tokens_user_idx').on(t.userId),
  }),
)

export type DbMcpToken = typeof mcpTokens.$inferSelect
export type DbMcpTokenInsert = typeof mcpTokens.$inferInsert
