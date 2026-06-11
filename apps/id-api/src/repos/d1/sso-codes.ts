import { and, eq, isNull, lt } from 'drizzle-orm'
import { ssoCodes } from '@rallypoint/db'
import type { UserId } from '@rallypoint/shared'
import type { SsoCodeRecord, SsoCodeRepo } from '../sso-code.js'
import type { Db } from './db.js'

function rowToRecord(row: typeof ssoCodes.$inferSelect): SsoCodeRecord {
  return {
    codeHash: row.codeHash,
    userId: row.userId as UserId,
    mintingSessionIdHash: row.mintingSessionIdHash,
    client: row.client,
    returnToHost: row.returnToHost,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  }
}

export class D1SsoCodeRepo implements SsoCodeRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    codeHash: string
    userId: UserId
    tenantId: string
    mintingSessionIdHash?: string | null
    client: string
    returnToHost: string
    expiresAt: Date
  }): Promise<void> {
    await this.db.insert(ssoCodes).values({
      codeHash: input.codeHash,
      userId: input.userId,
      mintingSessionIdHash: input.mintingSessionIdHash ?? null,
      client: input.client,
      returnToHost: input.returnToHost,
      expiresAt: input.expiresAt,
    })
  }

  async findByCodeHash(codeHash: string): Promise<SsoCodeRecord | null> {
    const rows = await this.db
      .select()
      .from(ssoCodes)
      .where(eq(ssoCodes.codeHash, codeHash))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async markConsumed(codeHash: string, when: Date): Promise<boolean> {
    // Atomic single-use guard: only flip the row if consumed_at is
    // still NULL. Concurrent calls race at the DB; D1 serialises
    // the UPDATEs and the loser's WHERE clause matches zero rows.
    const rows = await this.db
      .update(ssoCodes)
      .set({ consumedAt: when })
      .where(and(eq(ssoCodes.codeHash, codeHash), isNull(ssoCodes.consumedAt)))
      .returning({ codeHash: ssoCodes.codeHash })
    return rows.length > 0
  }

  async pruneExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(ssoCodes)
      .where(lt(ssoCodes.expiresAt, now))
      .returning({ codeHash: ssoCodes.codeHash })
    return rows.length
  }
}
