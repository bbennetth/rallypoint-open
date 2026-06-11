import { sqliteTable, primaryKey, text } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'
import { artists } from './artists.js'
import { eventStages } from './event-stages.js'
import { eventDays } from './event-days.js'

// event_artists — the lineup join linking a global `artists` row to an
// event with per-event scheduling metadata (design §5.2). No surrogate
// id: the primary key is (event_id, artist_id, day_id), so an artist
// playing multiple days gets one row per day. day_id is therefore NOT
// NULL (PK columns can't be null — §5.2 lists it nullable but the PK
// it also specifies forbids that; we keep the PK and require a day).
// stage_id / start_time / end_time stay nullable for partially-known
// schedules. display_name overrides artists.name for this event only.
//
// Cascades: event delete and day delete both remove the lineup row;
// stage delete nulls the slot's stage (keeps the booking, drops the
// stage assignment). artist_id has no cascade — a referenced artist
// can't be deleted out from under a lineup.
//
// time('start_time')/time('end_time') → text; HH:MM:SS string.

export const eventArtists = sqliteTable(
  'event_artists',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id),
    dayId: text('day_id')
      .notNull()
      .references(() => eventDays.id, { onDelete: 'cascade' }),
    stageId: text('stage_id').references(() => eventStages.id, { onDelete: 'set null' }),
    tier: text('tier'),
    genre: text('genre'),
    // time('start_time')/time('end_time') → text; HH:MM:SS string.
    startTime: text('start_time'),
    endTime: text('end_time'),
    displayName: text('display_name'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.artistId, t.dayId] }),
  }),
)

export type DbEventArtist = typeof eventArtists.$inferSelect
export type DbEventArtistInsert = typeof eventArtists.$inferInsert
