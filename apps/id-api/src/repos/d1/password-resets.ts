import { eq, lt } from 'drizzle-orm'
import { passwordResets } from '@rallypoint/db'
import type { UserId } from '@rallypoint/shared'
import type { PasswordResetRecord, PasswordResetRepo } from '../password-reset.js'
import type { Db } from './db.js'

function rowToRecord(row: typeof passwordResets.$inferSelect): PasswordResetRecord {
  return {
    tokenHash: row.tokenHash,
    userId: row.userId as UserId,
    tenantId: row.tenantId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  }
}

export class D1PasswordResetRepo implements PasswordResetRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    tokenHash: string
    userId: UserId
    tenantId: string
    expiresAt: Date
  }): Promise<void> {
    await this.db.insert(passwordResets).values(input)
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetRecord | null> {
    const rows = await this.db
      .select()
      .from(passwordResets)
      .where(eq(passwordResets.tokenHash, tokenHash))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async markConsumed(tokenHash: string, when: Date): Promise<void> {
    await this.db
      .update(passwordResets)
      .set({ consumedAt: when })
      .where(eq(passwordResets.tokenHash, tokenHash))
  }

  async deleteAllForUser(userId: UserId): Promise<number> {
    const rows = await this.db
      .delete(passwordResets)
      .where(eq(passwordResets.userId, userId))
      .returning({ tokenHash: passwordResets.tokenHash })
    return rows.length
  }

  async pruneExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(passwordResets)
      .where(lt(passwordResets.expiresAt, now))
      .returning({ tokenHash: passwordResets.tokenHash })
    return rows.length
  }
}
