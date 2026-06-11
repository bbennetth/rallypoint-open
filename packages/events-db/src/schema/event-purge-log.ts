import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// event_purge_log — append-only operator/forensic record of every
// hard-purge the 2c sweep performs (design doc §5.1.1). id is
// `epl_<ulid>`. This is the durable home of the `event.hard_deleted`
// audit event: it deliberately does NOT reference events.id, because
// the event row is gone by the time we write here — a cascading FK
// would delete the very record we are trying to keep. event_activity
// (which DOES cascade) cannot hold this one event for that reason.
// event_id/owner_user_id/tenant_id are kept as plain text snapshots.
// The Tasks-app cross-app reaper (#84) will later subscribe to these
// purges via PG LISTEN/NOTIFY — mechanism still TBD.

export const eventPurgeLog = sqliteTable(
  'event_purge_log',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    // When the event was soft-deleted (the deleted_at we swept past).
    // timestamp({ withTimezone }) → integer(mode:'timestamp_ms').
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }).notNull(),
    // sql`now()` → (unixepoch() * 1000).
    purgedAt: integer('purged_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    daysAfterGrace: integer('days_after_grace').notNull(),
    objectsReaped: integer('objects_reaped').notNull().default(0),
    objectsFailed: integer('objects_failed').notNull().default(0),
    // jsonb({}) → text(mode:'json') with sql`'{}'` default.
    meta: text('meta', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
  },
  (t) => ({
    purgedAtIdx: index('event_purge_log_purged_at_idx').on(t.purgedAt),
    eventIdx: index('event_purge_log_event_idx').on(t.eventId),
  }),
)

export type DbEventPurgeLog = typeof eventPurgeLog.$inferSelect
export type DbEventPurgeLogInsert = typeof eventPurgeLog.$inferInsert
