import { and, eq, isNull, lt } from 'drizzle-orm'
import { webauthnChallenges } from '@rallypoint/db'
import type { UserId } from '@rallypoint/shared'
import type {
  WebAuthnChallengeRecord,
  WebAuthnChallengeRepo,
  WebAuthnChallengePurpose,
} from '../webauthn-challenge.js'
import type { Db } from './db.js'

function rowToRecord(row: typeof webauthnChallenges.$inferSelect): WebAuthnChallengeRecord {
  return {
    challengeHash: row.challengeHash,
    userId: (row.userId as UserId | null) ?? null,
    tenantId: row.tenantId,
    purpose: row.purpose as WebAuthnChallengePurpose,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  }
}

export class D1WebAuthnChallengeRepo implements WebAuthnChallengeRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    challengeHash: string
    userId?: UserId | null
    tenantId: string
    purpose: WebAuthnChallengePurpose
    expiresAt: Date
  }): Promise<void> {
    await this.db.insert(webauthnChallenges).values({
      challengeHash: input.challengeHash,
      userId: input.userId ?? null,
      tenantId: input.tenantId,
      purpose: input.purpose,
      expiresAt: input.expiresAt,
    })
  }

  async findByHash(challengeHash: string): Promise<WebAuthnChallengeRecord | null> {
    const rows = await this.db
      .select()
      .from(webauthnChallenges)
      .where(eq(webauthnChallenges.challengeHash, challengeHash))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async markConsumed(challengeHash: string, when: Date): Promise<boolean> {
    const rows = await this.db
      .update(webauthnChallenges)
      .set({ consumedAt: when })
      .where(
        and(
          eq(webauthnChallenges.challengeHash, challengeHash),
          isNull(webauthnChallenges.consumedAt),
        ),
      )
      .returning({ challengeHash: webauthnChallenges.challengeHash })
    return rows.length > 0
  }

  async pruneExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(webauthnChallenges)
      .where(lt(webauthnChallenges.expiresAt, now))
      .returning({ challengeHash: webauthnChallenges.challengeHash })
    return rows.length
  }
}
