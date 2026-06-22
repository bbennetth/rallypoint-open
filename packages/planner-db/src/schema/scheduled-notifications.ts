import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

// scheduled_notifications — the enqueue-on-write queue backing planner push
// notifications. When planner-api proxies a write for a timed item (a
// personal event with a real start instant in Phase 1; tasks + chores in
// Phase 2), it upserts a row here keyed (user_id, dedupe_key); the
// notifications cron drains rows whose fire_at has passed and sends Web Push.
//
//   dedupe_key  — stable per source item, e.g. `event:<eventId>`, so an edit
//                 re-enqueues (upsert) rather than duplicating, and a delete
//                 cancels it.
//   source      — 'event' | 'task' | 'chore' (Phase 1 only emits 'event').
//   fire_at     — the instant the notification should be delivered (= the
//                 item's due/start instant; "fire at the due time").
//   sent_at     — set once delivered (a successful send to >= 1 subscription,
//                 or a permanent give-up); the drain ignores sent/cancelled rows.
//   cancelled_at— set when the source item is deleted or becomes all-day.
//
// Infrastructure table, not domain storage — the documented exception to the
// planner-api "no domain tables" rule (see push-subscriptions.ts).

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
    // For recurring (chore) notifications: the IANA timezone + JSON recurrence
    // rule (freq/interval/byDay/dtstart/until/count/timeOfDay) the cron uses to
    // advance the single `series:<id>` row to its next occurrence after firing,
    // with no SDK call. Null for one-off (event/task) rows.
    tz: text('tz'),
    recurrence: text('recurrence'),
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
    dedupeIdx: uniqueIndex('planner_scheduled_notifications_dedupe_idx').on(
      t.userId,
      t.dedupeKey,
    ),
    fireAtIdx: index('planner_scheduled_notifications_fire_at_idx').on(t.fireAt),
  }),
)

export type DbScheduledNotification = typeof scheduledNotifications.$inferSelect
export type DbScheduledNotificationInsert = typeof scheduledNotifications.$inferInsert
