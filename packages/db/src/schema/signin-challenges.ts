import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { users } from './users.js'

// signin_challenges — one row per in-flight 2FA challenge.
// challenge_id is the opaque handle returned to the client after
// password verification; the client uses it to submit the 6-digit
// code on /signin/complete. code_hmac is HMAC-SHA256(code,
// SIGNIN_CODE_HMAC_KEY) — we never store the code in plaintext.
//
// attempts_remaining ticks down on each /signin/complete attempt;
// when it hits zero we set locked_at and force the user to restart
// the signin flow (rate-limit the restart elsewhere).

export const signinChallenges = sqliteTable(
  'signin_challenges',
  {
    challengeId: text('challenge_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    codeHmac: text('code_hmac').notNull(),
    attemptsRemaining: integer('attempts_remaining').notNull().default(5),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
    lastCodeIssuedAt: integer('last_code_issued_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userIdx: index('signin_challenges_user_idx').on(t.userId),
    expiresIdx: index('signin_challenges_expires_idx').on(t.expiresAt),
  }),
)

export type DbSigninChallenge = typeof signinChallenges.$inferSelect
export type DbSigninChallengeInsert = typeof signinChallenges.$inferInsert
