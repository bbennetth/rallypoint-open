import { sql } from 'drizzle-orm'
import { sqliteTable, primaryKey, text, integer } from 'drizzle-orm/sqlite-core'
import { artists } from './artists.js'
import { events } from './events.js'

// event_artist_favorites — per-user favorites on ARTISTS within an event.
// Unlike event_set_stars (which star a specific lineup slot keyed by
// day), a favorite is day-agnostic: attendees can favorite an artist
// while the whole lineup is still TBA, and the favorite survives the
// slot being rescheduled to a different day.
//
// No surrogate id: natural PK (user_id, event_id, artist_id). user_id
// is a `user_<ulid>` cross-schema reference (not FK'd), same convention
// as event_set_stars.user_id.
//
// FKs to events and artists (NOT to event_artists) so the favorite is
// independent of slot shape; the route layer verifies the artist is on
// the event's lineup before allowing a favorite. ON DELETE CASCADE
// drops favorites when the event or the catalog artist goes away.
//
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const eventArtistFavorites = sqliteTable(
  'event_artist_favorites',
  {
    userId: text('user_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    artistId: text('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.eventId, t.artistId] }),
  }),
)

export type DbEventArtistFavorite = typeof eventArtistFavorites.$inferSelect
export type DbEventArtistFavoriteInsert = typeof eventArtistFavorites.$inferInsert
