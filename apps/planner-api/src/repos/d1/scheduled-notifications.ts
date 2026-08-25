import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm'
import { scheduledNotifications } from '@rallypoint/planner-db'
import type {
  ScheduledNotificationRecord,
  ScheduledNotificationRepo,
  ScheduledNotificationUpsert,
} from '../types.js'
import type { Db } from './db.js'

// D1 impl of the enqueue-on-write notification queue. Upsert is keyed on the
// (user_id, dedupe_key) unique index so an edited source item reschedules in
// place; the cron drains rows whose fire_at has passed.

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
    tz: row.tz ?? null,
    recurrence: row.recurrence ?? null,
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

  async upsert(input: ScheduledNotificationUpsert, now: Date): Promise<void> {
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
        tz: input.tz ?? null,
        recurrence: input.recurrence ?? null,
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
          tz: input.tz ?? null,
          recurrence: input.recurrence ?? null,
          updatedAt: now,
          // Revive the row so an edit re-fires at the new time.
          sentAt: null,
          attempts: 0,
          lastError: null,
          cancelledAt: null,
        },
      })
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
    // Guarded UPDATE that flips sent_at from NULL to `when` BEFORE any send.
    // Of two overlapping cron ticks only one wins the CAS; the loser sees
    // zero changed rows and skips the send entirely, so a row delivers at
    // most once. The claim is also the sent-mark — success paths need no
    // further write.
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
    // Single CAS guarded on sent_at = claimedAt (our own claim): a row revived
    // by a reschedule upsert (sent_at → NULL) or re-claimed by another
    // deliverer mid-flight is left alone (null). Below maxAttempts the claim is
    // reverted (sent_at → NULL) so the next cron pass retries; at the cap the
    // claim is kept so the row stays retired — one statement, no
    // revert-then-re-mark window a revive could slip into. SQLite SET
    // expressions read pre-update values, so the CASE sees the old `attempts`.
    const rows = await this.db
      .update(scheduledNotifications)
      .set({
        sentAt: sql`CASE WHEN ${scheduledNotifications.attempts} + 1 >= ${maxAttempts} THEN ${scheduledNotifications.sentAt} ELSE NULL END`,
        attempts: sql`${scheduledNotifications.attempts} + 1`,
        lastError: error.slice(0, 500),
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

  async advanceFireAt(
    input: { id: string; currentFireAt: Date; nextFireAt: Date; claimedAt: Date },
    now: Date,
  ): Promise<boolean> {
    // Conditional CAS-style advance (audit E2 #14). Only succeeds if the row
    // is still at `currentFireAt` AND still holds this caller's claim
    // (sent_at = claimedAt) — meaning no other cron isolate advanced it and no
    // reschedule upsert revived it (a revive nulls sent_at, so the guard
    // misses and the fresh schedule survives). Returns true when this caller
    // did the advance.
    const rows = await this.db
      .update(scheduledNotifications)
      .set({
        fireAt: input.nextFireAt,
        sentAt: null,
        attempts: 0,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledNotifications.id, input.id),
          eq(scheduledNotifications.fireAt, input.currentFireAt),
          eq(scheduledNotifications.sentAt, input.claimedAt),
        ),
      )
      .returning({ id: scheduledNotifications.id })
    return rows.length > 0
  }
}
