import { sql } from 'drizzle-orm'
import { sqliteTable, index, integer, real, text } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'
import { eventMaps } from './event-maps.js'

// event_pois — points of interest placed on an event's map (design
// §5.4). id is `evp_<ulid>`. Cascades when the parent event is
// hard-purged; map_id is SET NULL when its map is deleted (a POI with
// null map_id applies to all layers / outlives a re-upload).
// category_id is the festival POI enum stored as free-form text so V2
// (#60) can make categories owner-defined without a schema migration.
// x_pct/y_pct are 0..100 percentages of the map image (resolution-
// independent); lat/lng are optional for outdoor wayfinding.
//
// numeric(precision, scale) → real: all four columns are coordinates
// (x_pct/y_pct are map-image percentages 0..100; lat/lng are GPS coords).
// real/double has ample precision for both uses — confirmed not money.
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const eventPois = sqliteTable(
  'event_pois',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    mapId: text('map_id').references(() => eventMaps.id, { onDelete: 'set null' }),
    categoryId: text('category_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    // numeric(8,5) → real: map-image percentage 0..100, coordinate precision only.
    xPct: real('x_pct').notNull(),
    // numeric(8,5) → real: map-image percentage 0..100, coordinate precision only.
    yPct: real('y_pct').notNull(),
    // numeric(9,6) → real: GPS latitude, coordinate precision only.
    lat: real('lat'),
    // numeric(9,6) → real: GPS longitude, coordinate precision only.
    lng: real('lng'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    eventMapIdx: index('event_pois_event_map_idx').on(t.eventId, t.mapId),
  }),
)

export type DbEventPoi = typeof eventPois.$inferSelect
export type DbEventPoiInsert = typeof eventPois.$inferInsert
