import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_activity — owner-facing, event-scoped activity log (design
// doc §5.1.1). id is `eva_<ulid>`. Distinct from RPID's operator
// `audit_log`: this lives in events_v1, cascades on hard-purge, and
// is read by the event's owner/editors. event_type is 'event.created'
// | 'event.patched' | 'event.soft_deleted' | 'event.restored' |
// 'event.invite_created' | 'event.invite_accepted' |
// 'event.ownership_transferred'. meta carries a no-secrets summary.
// The one event that must OUTLIVE the row — 'event.hard_deleted' —
// belongs to the operator store and is a 2c concern.

export const eventActivity = sqliteTable(
  'event_activity',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').notNull(),
    eventType: text('event_type').notNull(),
    // jsonb({}) → text(mode:'json') with sql`'{}'` default.
    meta: text('meta', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    // timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    eventCreatedIdx: index('event_activity_event_created_idx').on(t.eventId, t.createdAt),
  }),
)

export type DbEventActivity = typeof eventActivity.$inferSelect
export type DbEventActivityInsert = typeof eventActivity.$inferInsert
