import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

// scheduled_notifications — the queue backing fitness push notifications
// (rest timers today). The live session enqueues a row when a rest period
// starts (dedupe_key `rest:<tag>`, fire_at = the rest deadline) and
// cancels it on early finish / skip / local delivery. Delivery is
// primarily a Durable Object alarm set at fire_at (rest periods are
// 30 s–5 min, so a 1-minute cron would be uselessly late); the per-minute
// cron sweep is the safety net for alarms that failed to fire.
//
//   dedupe_key  — stable per source, e.g. `rest:<sessionId>` — an adjust
//                 re-enqueues (upsert) rather than duplicating; a skip
//                 cancels it.
//   sent_at     — set once delivered (>= 1 subscription, or a permanent
//                 give-up); drain/alarm ignore sent/cancelled rows.
//   cancelled_at— set when the rest ended early or alerted locally.
//
// Infrastructure table mirroring planner-api's queue (each app owns its
// own notifications).

export const scheduledNotifications = sqliteTable(
  'scheduled_notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    source: text('source').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    url: text('url').notNull(),
    fireAt: integer('fire_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    cancelledAt: integer('cancelled_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    dedupeIdx: uniqueIndex('fitness_scheduled_notifications_dedupe_idx').on(
      t.userId,
      t.dedupeKey,
    ),
    fireAtIdx: index('fitness_scheduled_notifications_fire_at_idx').on(t.fireAt),
  }),
)

export type DbScheduledNotification = typeof scheduledNotifications.$inferSelect
export type DbScheduledNotificationInsert = typeof scheduledNotifications.$inferInsert
