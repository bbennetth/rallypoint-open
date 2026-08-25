import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm'
import { scheduledNotifications } from '@rallypoint/fitness-db'
import type {
  ScheduledNotificationRecord,
  ScheduledNotificationRepo,
  ScheduledNotificationUpsert,
} from '../types.js'
import type { Db } from './db.js'

// D1 impl of the rest-timer notification queue (mirrors planner-api's,
// minus the recurring-advance machinery — rest timers are one-off).
// Upsert is keyed on the (user_id, dedupe_key) unique index so an
// adjusted rest deadline reschedules in place; the DO alarm delivers at
// fire_at and the per-minute cron sweeps anything the alarm missed.

function rowToRecord(
  row: typeof scheduledNotifications.$inferSelect,
): ScheduledNotificationRecord {
  return {
    id: row.id,
    userId: row.userId,
    dedupeKey: row.dedupeKey,
    source: row.source,
    title: row.title,
    body: row.body ?? null,
    url: row.url,
    fireAt: row.fireAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sentAt: row.sentAt ?? null,
    attempts: row.attempts,
    lastError: row.lastError ?? null,
    cancelledAt: row.cancelledAt ?? null,
  }
}

export class D1ScheduledNotificationRepo implements ScheduledNotificationRepo {
  constructor(private readonly db: Db) {}

  async upsert(input: ScheduledNotificationUpsert, now: Date): Promise<string> {
    await this.db
      .insert(scheduledNotifications)
      .values({
        id: input.id,
        userId: input.userId,
        dedupeKey: input.dedupeKey,
        source: input.source,
        title: input.title,
        body: input.body,
        url: input.url,
        fireAt: input.fireAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [scheduledNotifications.userId, scheduledNotifications.dedupeKey],
        set: {
          source: input.source,
          title: input.title,
          body: input.body,
          url: input.url,
          fireAt: input.fireAt,
          updatedAt: now,
          // Revive the row so an adjusted timer re-fires at the new time.
          sentAt: null,
          attempts: 0,
          lastError: null,
          cancelledAt: null,
        },
      })
    // On conflict the surviving row keeps its ORIGINAL id — read it back
    // so the caller can point the DO alarm at the right row.
    const row = await this.db
      .select({ id: scheduledNotifications.id })
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.userId, input.userId),
          eq(scheduledNotifications.dedupeKey, input.dedupeKey),
        ),
      )
      .get()
    return row?.id ?? input.id
  }

  async cancel(userId: string, dedupeKey: string, when: Date): Promise<void> {
    await this.db
      .update(scheduledNotifications)
      .set({ cancelledAt: when, updatedAt: when })
      .where(
        and(
          eq(scheduledNotifications.userId, userId),
          eq(scheduledNotifications.dedupeKey, dedupeKey),
          isNull(scheduledNotifications.sentAt),
          isNull(scheduledNotifications.cancelledAt),
        ),
      )
  }

  async getById(id: string): Promise<ScheduledNotificationRecord | null> {
    const row = await this.db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.id, id))
      .get()
    return row ? rowToRecord(row) : null
  }

  async listDue(now: Date, limit: number): Promise<ScheduledNotificationRecord[]> {
    const rows = await this.db
      .select()
      .from(scheduledNotifications)
      .where(
        and(
          isNull(scheduledNotifications.sentAt),
          isNull(scheduledNotifications.cancelledAt),
          lte(scheduledNotifications.fireAt, now),
        ),
      )
      .orderBy(asc(scheduledNotifications.fireAt))
      .limit(limit)
    return rows.map(rowToRecord)
  }

  async markSent(id: string, when: Date): Promise<void> {
    await this.db
      .update(scheduledNotifications)
      .set({ sentAt: when, updatedAt: when })
      .where(eq(scheduledNotifications.id, id))
  }

  async claimForSend(id: string, when: Date): Promise<boolean> {
    // Guarded UPDATE (mirrors planner-api's race-fix pattern): only one
    // of two concurrent deliverers flips sent_at from NULL, so the loser
    // sees zero changed rows and skips the send entirely.
    const rows = await this.db
      .update(scheduledNotifications)
      .set({ sentAt: when, updatedAt: when })
      .where(
        and(
          eq(scheduledNotifications.id, id),
          isNull(scheduledNotifications.sentAt),
          isNull(scheduledNotifications.cancelledAt),
        ),
      )
      .returning({ id: scheduledNotifications.id })
    return rows.length > 0
  }

  async recordFailure(
    id: string,
    error: string,
    claimedAt: Date,
    maxAttempts: number,
  ): Promise<number | null> {
    // Single CAS guarded on sent_at = claimedAt (our own claim): a row
    // revived by a reschedule upsert or re-claimed by another deliverer
    // mid-flight is left alone (null). Below maxAttempts the claim is
    // reverted (sent_at → NULL) so the next cron pass retries; at the cap
    // the claim is kept so the row stays retired — one statement, no
    // revert-then-re-mark window a revive could slip into. SQLite SET
    // expressions read pre-update values, so the CASE sees the old
    // `attempts`. Tiny known hole: a cancel issued while the row is
    // claimed no-ops (cancel's WHERE requires sent_at IS NULL) and the
    // retry revert then revives the row — a millisecond-scale window,
    // strictly better than the pre-claim double-send it replaced.
    const rows = await this.db
      .update(scheduledNotifications)
      .set({
        sentAt: sql`CASE WHEN ${scheduledNotifications.attempts} + 1 >= ${maxAttempts} THEN ${scheduledNotifications.sentAt} ELSE NULL END`,
        attempts: sql`${scheduledNotifications.attempts} + 1`,
        lastError: error,
        updatedAt: claimedAt,
      })
      .where(
        and(
          eq(scheduledNotifications.id, id),
          eq(scheduledNotifications.sentAt, claimedAt),
        ),
      )
      .returning({ attempts: scheduledNotifications.attempts })
    return rows[0]?.attempts ?? null
  }
}
