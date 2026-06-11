import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { rallies } from './rallies.js'

// rally_attendees — a group member's RSVP to a rally (Slice 9b). id is
// `rta_<ulid>`. rally_id CASCADEs (deleting a rally drops its RSVPs).
// user_id is a `user_<ulid>` (not FK'd — cross-schema). status is
// going | maybe | out. responded_at records when the RSVP last changed.
// One RSVP per (rally, user) — re-RSVPing upserts the row.
//
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const rallyAttendees = sqliteTable(
  'rally_attendees',
  {
    id: text('id').primaryKey(),
    rallyId: text('rally_id')
      .notNull()
      .references(() => rallies.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    status: text('status').notNull(),
    respondedAt: integer('responded_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    rallyUserIdx: uniqueIndex('rally_attendees_rally_user_idx').on(t.rallyId, t.userId),
  }),
)

export type DbRallyAttendee = typeof rallyAttendees.$inferSelect
export type DbRallyAttendeeInsert = typeof rallyAttendees.$inferInsert
