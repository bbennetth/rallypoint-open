import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { signinChallenges } from '@rallypoint/db'
import type { UserId } from '@rallypoint/shared'
import type {
  SigninChallengeRecord,
  SigninChallengeRepo,
} from '../signin-challenge.js'
import { INITIAL_ATTEMPTS } from '../memory-signin-challenges.js'
import type { Db } from './db.js'

function rowToRecord(row: typeof signinChallenges.$inferSelect): SigninChallengeRecord {
  return {
    challengeId: row.challengeId,
    userId: row.userId as UserId,
    tenantId: row.tenantId,
    codeHmac: row.codeHmac,
    attemptsRemaining: row.attemptsRemaining,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    lockedAt: row.lockedAt,
    lastCodeIssuedAt: row.lastCodeIssuedAt,
  }
}

export class D1SigninChallengeRepo implements SigninChallengeRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    challengeId: string
    userId: UserId
    tenantId: string
    codeHmac: string
    expiresAt: Date
    attemptsRemaining?: number
  }): Promise<void> {
    await this.db.insert(signinChallenges).values({
      challengeId: input.challengeId,
      userId: input.userId,
      tenantId: input.tenantId,
      codeHmac: input.codeHmac,
      expiresAt: input.expiresAt,
      attemptsRemaining: input.attemptsRemaining ?? 5,
    })
  }

  async findByChallengeId(challengeId: string): Promise<SigninChallengeRecord | null> {
    const rows = await this.db
      .select()
      .from(signinChallenges)
      .where(eq(signinChallenges.challengeId, challengeId))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async rotateCode(input: {
    challengeId: string
    codeHmac: string
    issuedAt: Date
  }): Promise<void> {
    await this.db
      .update(signinChallenges)
      .set({
        codeHmac: input.codeHmac,
        // Reset baked-in (#31) so the next code starts with a
        // fresh attempt budget — callers can't forget.
        attemptsRemaining: INITIAL_ATTEMPTS,
        lastCodeIssuedAt: input.issuedAt,
      })
      .where(eq(signinChallenges.challengeId, input.challengeId))
  }

  async decrementAttempts(challengeId: string): Promise<number> {
    // Atomic: clamp at zero via MAX in SQL (SQLite's scalar clamp).
    const rows = await this.db
      .update(signinChallenges)
      .set({
        attemptsRemaining: sql`MAX(${signinChallenges.attemptsRemaining} - 1, 0)`,
      })
      .where(eq(signinChallenges.challengeId, challengeId))
      .returning({ attemptsRemaining: signinChallenges.attemptsRemaining })
    return rows[0]?.attemptsRemaining ?? 0
  }

  async markConsumed(challengeId: string, when: Date): Promise<number> {
    // Conditional UPDATE (#25): only flip consumed_at if the row
    // is still in flight (not already consumed AND not locked).
    // Returns rowcount so the caller can detect a lost race.
    const rows = await this.db
      .update(signinChallenges)
      .set({ consumedAt: when })
      .where(
        and(
          eq(signinChallenges.challengeId, challengeId),
          isNull(signinChallenges.consumedAt),
          isNull(signinChallenges.lockedAt),
        ),
      )
      .returning({ challengeId: signinChallenges.challengeId })
    return rows.length
  }

  async markLocked(challengeId: string, when: Date): Promise<number> {
    // Symmetric to markConsumed — only lock an in-flight row.
    const rows = await this.db
      .update(signinChallenges)
      .set({ lockedAt: when })
      .where(
        and(
          eq(signinChallenges.challengeId, challengeId),
          isNull(signinChallenges.consumedAt),
          isNull(signinChallenges.lockedAt),
        ),
      )
      .returning({ challengeId: signinChallenges.challengeId })
    return rows.length
  }

  async pruneExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(signinChallenges)
      .where(lt(signinChallenges.expiresAt, now))
      .returning({ challengeId: signinChallenges.challengeId })
    return rows.length
  }
}
