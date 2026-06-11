import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import { emailChanges } from '@rallypoint/db'
import type { UserId } from '@rallypoint/shared'
import type { EmailChangeRecord, EmailChangeRepo } from '../email-change.js'
import type { Db } from './db.js'

function rowToRecord(row: typeof emailChanges.$inferSelect): EmailChangeRecord {
  return {
    tokenHash: row.tokenHash,
    userId: row.userId as UserId,
    tenantId: row.tenantId,
    newEmail: row.newEmail,
    oldEmail: row.oldEmail,
    cancelTokenHash: row.cancelTokenHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    cancelledAt: row.cancelledAt,
  }
}

export class D1EmailChangeRepo implements EmailChangeRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    tokenHash: string
    cancelTokenHash: string
    userId: UserId
    tenantId: string
    newEmail: string
    oldEmail: string
    expiresAt: Date
  }): Promise<void> {
    await this.db.insert(emailChanges).values(input)
  }

  async findByTokenHash(tokenHash: string): Promise<EmailChangeRecord | null> {
    const rows = await this.db
      .select()
      .from(emailChanges)
      .where(eq(emailChanges.tokenHash, tokenHash))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async findByCancelTokenHash(cancelTokenHash: string): Promise<EmailChangeRecord | null> {
    const rows = await this.db
      .select()
      .from(emailChanges)
      .where(eq(emailChanges.cancelTokenHash, cancelTokenHash))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async findActiveForUser(userId: UserId, now?: Date): Promise<EmailChangeRecord | null> {
    const rows = await this.db
      .select()
      .from(emailChanges)
      .where(
        and(
          eq(emailChanges.userId, userId),
          isNull(emailChanges.consumedAt),
          isNull(emailChanges.cancelledAt),
          gt(emailChanges.expiresAt, now ?? new Date()),
        ),
      )
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async markConsumed(tokenHash: string, when: Date): Promise<void> {
    await this.db
      .update(emailChanges)
      .set({ consumedAt: when })
      .where(eq(emailChanges.tokenHash, tokenHash))
  }

  async markCancelled(cancelTokenHash: string, when: Date): Promise<void> {
    await this.db
      .update(emailChanges)
      .set({ cancelledAt: when })
      .where(eq(emailChanges.cancelTokenHash, cancelTokenHash))
  }

  async deleteAllForUser(userId: UserId): Promise<number> {
    const rows = await this.db
      .delete(emailChanges)
      .where(eq(emailChanges.userId, userId))
      .returning({ tokenHash: emailChanges.tokenHash })
    return rows.length
  }

  async pruneExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(emailChanges)
      .where(lt(emailChanges.expiresAt, now))
      .returning({ tokenHash: emailChanges.tokenHash })
    return rows.length
  }
}
