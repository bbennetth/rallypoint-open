import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'

// artists — a GLOBAL, cross-event catalog of performers (design §5.2).
// Deliberately has no event_id/tenant_id: the same artist plays many
// events, so the row is shared and linked per-event via event_artists.
// id is `art_<ulid>`. The music-link columns are optional profile URLs.
// unique(lower(name)) prevents case-insensitive duplicates ("Skrillex"
// vs "skrillex") — the route does a find-or-create against it.
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const artists = sqliteTable(
  'artists',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    soundcloud: text('soundcloud'),
    spotify: text('spotify'),
    appleMusic: text('apple_music'),
    youtubeMusic: text('youtube_music'),
    instagram: text('instagram'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    // lower(name) expression index — drizzle-kit emits the predicate for SQLite.
    lowerNameIdx: uniqueIndex('artists_lower_name_idx').on(sql`lower(${t.name})`),
  }),
)

export type DbArtist = typeof artists.$inferSelect
export type DbArtistInsert = typeof artists.$inferInsert
