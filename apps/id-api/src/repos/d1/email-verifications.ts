import { eq, lt } from 'drizzle-orm'
import type { UserId } from '@rallypoint/shared'
import { emailVerifications as table } from '@rallypoint/db'
import type { EmailVerification, EmailVerificationRepo } from '../types.js'
import type { Db } from './db.js'

function rowToVerification(row: typeof table.$inferSelect): EmailVerification {
  return {
    tokenHash: row.tokenHash,
    userId: row.userId as UserId,
    tenantId: row.tenantId,
    email: row.email,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  }
}

export class D1EmailVerificationRepo implements EmailVerificationRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    tokenHash: string
    userId: UserId
    tenantId: string
    email: string
    expiresAt: Date
  }): Promise<void> {
    await this.db.insert(table).values(input)
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerification | null> {
    const rows = await this.db
      .select()
      .from(table)
      .where(eq(table.tokenHash, tokenHash))
      .limit(1)
    return rows[0] ? rowToVerification(rows[0]) : null
  }

  async markConsumed(tokenHash: string, when: Date): Promise<void> {
    await this.db.update(table).set({ consumedAt: when }).where(eq(table.tokenHash, tokenHash))
  }

  async deleteAllForUser(userId: UserId): Promise<number> {
    const rows = await this.db.delete(table).where(eq(table.userId, userId)).returning()
    return rows.length
  }

  async pruneExpired(now: Date): Promise<number> {
    const rows = await this.db.delete(table).where(lt(table.expiresAt, now)).returning()
    return rows.length
  }
}
