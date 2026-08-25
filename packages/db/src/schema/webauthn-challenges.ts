import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// webauthn_challenges — ephemeral per-ceremony challenge store for both
// the registration ('register') and authentication ('auth') WebAuthn
// ceremonies. The random challenge is handed to the browser in the
// start step; on finish we re-derive its hash from the returned
// clientDataJSON and look the row up here, verifying it is unconsumed +
// unexpired, then mark it consumed (single-use, race-safe like
// sso_codes.markConsumed). Modeled on signin_challenges.
//
// challenge_hash = SHA-256(base64url challenge) hex, PK — the raw
// challenge is never stored. user_id is set for 'register' (the signed-
// in user adding a passkey) and NULL for 'auth' (usernameless/
// discoverable login — the user is unknown until the assertion names a
// credential). No FK on user_id so an 'auth' row needs no user.

export const webauthnChallenges = sqliteTable(
  'webauthn_challenges',
  {
    challengeHash: text('challenge_hash').primaryKey(),
    userId: text('user_id'),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    purpose: text('purpose').notNull(), // 'register' | 'auth'
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    expiresIdx: index('webauthn_challenges_expires_idx').on(t.expiresAt),
  }),
)
