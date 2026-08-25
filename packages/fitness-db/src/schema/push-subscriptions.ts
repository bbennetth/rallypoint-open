import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// push_subscriptions — Web Push (RFC 8291) subscriptions registered by the
// fitness-web service worker, one row per browser/device endpoint. Mirrors
// planner-api's table of the same name (each app owns its own
// notifications); backs the rest-timer push feature: the DO alarm / cron
// drains scheduled_notifications and fans out to these subscriptions.
//
// id_hash = SHA-256(endpoint) hex — dedupes re-subscribes of the same
// endpoint (upsert). p256dh + auth are the subscription's base64url keys
// (decoded to bytes by @rallypoint/web-push at send time). A user may have
// many rows (one per device); dead endpoints (push service 404/410) are
// reaped at send time.

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('fitness_push_subscriptions_user_idx').on(t.userId),
  }),
)

export type DbPushSubscription = typeof pushSubscriptions.$inferSelect
export type DbPushSubscriptionInsert = typeof pushSubscriptions.$inferInsert
