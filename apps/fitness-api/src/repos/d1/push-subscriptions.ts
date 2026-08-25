import { eq } from 'drizzle-orm'
import { pushSubscriptions } from '@rallypoint/fitness-db'
import type {
  PushSubscriptionRecord,
  PushSubscriptionRepo,
  PushSubscriptionUpsert,
} from '../types.js'
import type { Db } from './db.js'

// D1 impl of the Web Push subscription store (mirrors planner-api). One
// row per endpoint (id_hash = SHA-256(endpoint)); a re-subscribe of the
// same endpoint upserts its keys.

function rowToRecord(row: typeof pushSubscriptions.$inferSelect): PushSubscriptionRecord {
  return {
    idHash: row.idHash,
    userId: row.userId,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.createdAt,
    lastSuccessAt: row.lastSuccessAt ?? null,
  }
}

export class D1PushSubscriptionRepo implements PushSubscriptionRepo {
  constructor(private readonly db: Db) {}

  async upsert(input: PushSubscriptionUpsert): Promise<void> {
    // On conflict (same endpoint already registered) userId IS reassigned
    // to the current registrant: a push endpoint is browser/SW-scoped, so
    // when a different user signs in on the same browser and re-subscribes
    // the same endpoint, they must take ownership (otherwise the previous
    // user's notifications would land on the new user's browser). The
    // endpoint URL is unguessable, so this can't be abused to hijack a
    // foreign subscription. Same rationale as planner-api's repo.
    await this.db
      .insert(pushSubscriptions)
      .values({
        idHash: input.idHash,
        userId: input.userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.idHash,
        set: {
          userId: input.userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
        },
      })
  }

  async listByUser(userId: string): Promise<PushSubscriptionRecord[]> {
    const rows = await this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
    return rows.map(rowToRecord)
  }

  async deleteByIdHash(idHash: string): Promise<void> {
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.idHash, idHash))
  }

  async markSuccess(idHash: string, when: Date): Promise<void> {
    await this.db
      .update(pushSubscriptions)
      .set({ lastSuccessAt: when })
      .where(eq(pushSubscriptions.idHash, idHash))
  }
}
