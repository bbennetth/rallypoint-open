import { sql } from 'drizzle-orm'
import { sqliteTable, foreignKey, primaryKey, text, integer } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_planner_prefs — per-user "show in planner" flag for a group event.
//
// Composite PK (event_id, user_id): one row per user per event.
// show_in_planner defaults to true so an explicit upsert(show=true)
// is idempotent on a brand-new row. user_id is a `user_<ulid>`
// cross-schema reference (not FK'd), same convention as event_attendees.
//
// FK event_id → events.id ON DELETE CASCADE: when an event is hard-purged
// its pref rows vanish with it; soft-deleted events are visible until the
// pruner hard-purges them (the app layer skips deleted events in the
// planner-events read anyway).
//
// updated_at uses (unixepoch()*1000) sentinel (timestamp_ms pattern),
// matching event-set-stars / event-attendees convention.

export const eventPlannerPrefs = sqliteTable(
  'event_planner_prefs',
  {
    eventId: text('event_id').notNull(),
    userId: text('user_id').notNull(),
    showInPlanner: integer('show_in_planner', { mode: 'boolean' }).notNull().default(true),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.userId] }),
    eventFk: foreignKey({
      columns: [t.eventId],
      foreignColumns: [events.id],
      name: 'event_planner_prefs_event_fk',
    }).onDelete('cascade'),
  }),
)

export type DbEventPlannerPref = typeof eventPlannerPrefs.$inferSelect
export type DbEventPlannerPrefInsert = typeof eventPlannerPrefs.$inferInsert
