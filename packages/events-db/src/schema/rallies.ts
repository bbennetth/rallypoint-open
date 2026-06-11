import { sql } from 'drizzle-orm'
import { sqliteTable, index, real, text, integer } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'
import { groups } from './groups.js'
import { eventDays } from './event-days.js'
import { eventPois } from './event-pois.js'

// rallies — a group's planned meet-up within an event (Slice 9b). id is
// `rally_<ulid>`. Lives under a group (CASCADE) and an event (CASCADE) so
// purging either removes it. Location is layered (not exclusive): an
// `event_pois` row (poi_id, SET NULL if the POI is deleted), a free-text
// label that doubles as a fallback, and an optional off-map lat/lng pair
// — all optional, no separate points/voting table in v1. day_id ties the
// rally to an event day (SET NULL).
// start_time is a Postgres `time` (no date — the day_id supplies it).
// status is proposed | active | cancelled. created_by is a `user_<ulid>`
// (not FK'd — cross-schema). Index on group_id for the per-group listing.
//
// time('start_time') → text; HH:MM:SS string.
// numeric(9,6) lat/lng → real: GPS coordinates, real has ample precision.
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const rallies = sqliteTable(
  'rallies',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    dayId: text('day_id').references(() => eventDays.id, { onDelete: 'set null' }),
    // time('start_time') → text; HH:MM:SS string.
    startTime: text('start_time'),
    poiId: text('poi_id').references(() => eventPois.id, { onDelete: 'set null' }),
    locationLabel: text('location_label'),
    // numeric(9,6) → real: GPS latitude, coordinate precision only.
    lat: real('lat'),
    // numeric(9,6) → real: GPS longitude, coordinate precision only.
    lng: real('lng'),
    status: text('status').notNull().default('proposed'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    groupIdx: index('rallies_group_idx').on(t.groupId),
  }),
)

export type DbRally = typeof rallies.$inferSelect
export type DbRallyInsert = typeof rallies.$inferInsert
