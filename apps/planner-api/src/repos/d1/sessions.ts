import { eq } from 'drizzle-orm'
import { sessions } from '@rallypoint/planner-db'
import type { PlannerSessionRecord, PlannerSessionRepo } from '../types.js'
import type { Db } from './db.js'

// D1/SQLite has no binary column type. The schema stores
// rpid_bearer_ciphertext and rpid_bearer_nonce as base64-encoded text
// (see packages/planner-db/src/schema/sessions.ts). We encode Buffers
// to base64 on write and decode back to Buffer on read, so the AES-GCM
// crypto layer (apps/planner-api/src/crypto/encryption.ts) is unchanged.
// Mirrors apps/money-api/src/repos/d1/sessions.ts.

function rowToSession(row: typeof sessions.$inferSelect): PlannerSessionRecord {
  return {
    idHash: row.idHash,
    userId: row.userId,
    rpidBearerCiphertext: Buffer.from(row.rpidBearerCiphertext, 'base64'),
    rpidBearerNonce: Buffer.from(row.rpidBearerNonce, 'base64'),
    rpidBearerKeyVersion: row.rpidBearerKeyVersion,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    ipHash: row.ipHash,
    uaHash: row.uaHash,
  }
}

export class D1PlannerSessionRepo implements PlannerSessionRepo {
  constructor(private readonly db: Db) {}

  async create(
    record: Omit<PlannerSessionRecord, 'createdAt' | 'lastSeenAt'> & {
      createdAt?: Date
      lastSeenAt?: Date
    },
  ): Promise<void> {
    await this.db.insert(sessions).values({
      idHash: record.idHash,
      userId: record.userId,
      // Encode Buffer → base64 text for storage in the SQLite text column.
      rpidBearerCiphertext: record.rpidBearerCiphertext.toString('base64'),
      rpidBearerNonce: record.rpidBearerNonce.toString('base64'),
      rpidBearerKeyVersion: record.rpidBearerKeyVersion,
      absoluteExpiresAt: record.absoluteExpiresAt,
      ipHash: record.ipHash,
      uaHash: record.uaHash,
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
    })
  }

  async findByIdHash(idHash: string): Promise<PlannerSessionRecord | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.idHash, idHash))
      .limit(1)
    return rows[0] ? rowToSession(rows[0]) : null
  }

  async touchLastSeen(idHash: string, when: Date): Promise<void> {
    await this.db.update(sessions).set({ lastSeenAt: when }).where(eq(sessions.idHash, idHash))
  }

  async deleteByIdHash(idHash: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.idHash, idHash))
  }
}
