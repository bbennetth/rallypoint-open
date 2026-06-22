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

  async recordFailure(id: string, error: string, when: Date): Promise<void> {
    // attempts += 1 without a read-modify-write race.
    await this.db
      .update(scheduledNotifications)
      .set({
        attempts: sql`${scheduledNotifications.attempts} + 1`,
        lastError: error.slice(0, 500),
        updatedAt: when,
      })
      .where(eq(scheduledNotifications.id, id))
  }
}
