import { sql } from 'drizzle-orm'
import { sqliteTable, foreignKey, primaryKey, text, integer } from 'drizzle-orm/sqlite-core'
import { eventArtists } from './event-artists.js'

// event_set_stars — per-user stars on individual lineup slots (sets).
// A "set" = an event_artists row identified by (event_id, artist_id,
// day_id). Stars are attendee-personal: many users can star the same
// slot independently.
//
// No surrogate id: the natural PK is (user_id, event_id, artist_id,
// day_id), matching the composite-PK convention used by event_artists.
// user_id is a `user_<ulid>` cross-schema reference (not FK'd), same
// convention as event_attendees.user_id.
//
// A single COMPOSITE FK ties (event_id, artist_id, day_id) to the
// event_artists slot it stars, ON DELETE CASCADE: a star can only point
// at a slot that actually exists, and removing the slot from the lineup
// drops the star with it (so a re-added slot never resurfaces a stale
// star). This also transitively covers event/day deletion, since
// event_artists itself cascades from events and event_days.
// created_at records when the user first starred the slot.
//
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const eventSetStars = sqliteTable(
  'event_set_stars',
  {
    userId: text('user_id').notNull(),
    eventId: text('event_id').notNull(),
    artistId: text('artist_id').notNull(),
    dayId: text('day_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.eventId, t.artistId, t.dayId] }),
    slotFk: foreignKey({
      columns: [t.eventId, t.artistId, t.dayId],
      foreignColumns: [eventArtists.eventId, eventArtists.artistId, eventArtists.dayId],
      name: 'event_set_stars_slot_fk',
    }).onDelete('cascade'),
  }),
)

export type DbEventSetStar = typeof eventSetStars.$inferSelect
export type DbEventSetStarInsert = typeof eventSetStars.$inferInsert
