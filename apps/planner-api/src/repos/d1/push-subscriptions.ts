import { eq } from 'drizzle-orm'
import { pushSubscriptions } from '@rallypoint/planner-db'
import type {
  PushSubscriptionRecord,
  PushSubscriptionRepo,
  PushSubscriptionUpsert,
} from '../types.js'
import type { Db } from './db.js'

// D1 impl of the Web Push subscription store. One row per endpoint
// (id_hash = SHA-256(endpoint)); a re-subscribe of the same endpoint
// upserts its keys.

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
    // On conflict (same endpoint already registered) we DO reassign userId to
    // the current registrant. A push endpoint is browser/SW-scoped, not
    // user-scoped: if user A enabled notifications then signed out and user B
    // signed in on the same browser, B re-subscribes the SAME endpoint and
    // must take ownership — otherwise A's reminders would be delivered to B's
    // browser. "Claiming" a foreign endpoint to deny A their notifications
    // would require knowing A's exact high-entropy push-service URL, which is
    // unguessable, so last-authenticated-registrant-wins is the safe rule.
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
