import { sql } from 'drizzle-orm'
import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'
import { artists } from './artists.js'
import { eventStages } from './event-stages.js'
import { eventDays } from './event-days.js'

// event_artists — the lineup join linking a global `artists` row to an
// event with per-event scheduling metadata (design §5.2). No surrogate
// id: identity is (event_id, artist_id, day_id), so an artist playing
// multiple days gets one row per day. day_id is NULLABLE (migration
// 0008 rebuild, replacing the original composite PK): a null day is an
// "unscheduled/TBA" booking — the artist is on the lineup before the
// festival announces day splits. Two unique indexes carry the identity:
//   - event_artists_slot_uq (event_id, artist_id, day_id) — the old PK
//     as a full unique index. SQLite treats NULLs as distinct here, so
//     it never constrains unscheduled rows; its real jobs are scheduled
//     -slot identity AND satisfying event_set_stars' composite FK
//     (which requires a parent unique index on exactly these columns).
//   - event_artists_unscheduled_uq (event_id, artist_id) WHERE day_id
//     IS NULL — at most ONE unscheduled slot per artist per event.
// stage_id / start_time / end_time stay nullable for partially-known
// schedules. display_name overrides artists.name for this event only.
//
// Cascades: event delete and day delete both remove the lineup row;
// stage delete nulls the slot's stage (keeps the booking, drops the
// stage assignment). artist_id has no cascade — a referenced artist
// can't be deleted out from under a lineup. Set-stars only ever
// reference scheduled slots (their day_id is NOT NULL), so null-day
// rows are unreferencable by construction.
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
    dayId: text('day_id').references(() => eventDays.id, { onDelete: 'cascade' }),
    stageId: text('stage_id').references(() => eventStages.id, { onDelete: 'set null' }),
    tier: text('tier'),
    genre: text('genre'),
    // time('start_time')/time('end_time') → text; HH:MM:SS string.
    startTime: text('start_time'),
    endTime: text('end_time'),
    displayName: text('display_name'),
  },
  (t) => ({
    slotUq: uniqueIndex('event_artists_slot_uq').on(t.eventId, t.artistId, t.dayId),
    unscheduledUq: uniqueIndex('event_artists_unscheduled_uq')
      .on(t.eventId, t.artistId)
      .where(sql`${t.dayId} IS NULL`),
  }),
)

export type DbEventArtist = typeof eventArtists.$inferSelect
export type DbEventArtistInsert = typeof eventArtists.$inferInsert
