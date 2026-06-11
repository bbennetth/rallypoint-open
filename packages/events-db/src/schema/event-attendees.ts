import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_attendees — first-class "I said yes to this event" rows
// (Phase 0 of the platform/v-1.1 events redesign). Independent of
// `event_members` (which holds owner / editor / viewer collaborator
// roles) and `group_members` (which holds intra-event group rosters,
// opaque to the event owner under the privacy rule).
//
// id is `eva_<ulid>`. event_id CASCADEs on event delete. user_id is a
// Rallypoint ID `user_<ulid>` (not FK'd — cross-schema). removed_at is
// the soft-remove marker — a deleted-by-owner row stays in the table
// for audit so a later re-invite preserves the original joined_at
// timestamp; a NULL removed_at means the attendee is currently
// considered "attending". (event_id, user_id) is unique so the same
// person can't double-attend.

export const eventAttendees = sqliteTable(
  'event_attendees',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    removedAt: integer('removed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    eventUserIdx: uniqueIndex('event_attendees_event_user_idx').on(
      t.eventId,
      t.userId,
    ),
  }),
)

export type DbEventAttendee = typeof eventAttendees.$inferSelect
export type DbEventAttendeeInsert = typeof eventAttendees.$inferInsert
