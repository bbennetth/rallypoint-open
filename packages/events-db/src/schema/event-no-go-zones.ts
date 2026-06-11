import { sqliteTable, index, text } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'
import { eventMaps } from './event-maps.js'

// event_no_go_zones — polygonal exclusion areas drawn on an event's
// map (design §5.4). id is `evz_<ulid>`. Cascades when the parent
// event is hard-purged; map_id cascades too — a zone is meaningless
// without its map (unlike a POI, which can float). polygon is a jsonb
// array of {xPct, yPct} vertices (0..100 percentages of the map image).
//
// jsonb('polygon') → text(mode:'json'): array of coordinate objects.
// No default — the column is always provided on insert (not null).

export const eventNoGoZones = sqliteTable(
  'event_no_go_zones',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    mapId: text('map_id')
      .notNull()
      .references(() => eventMaps.id, { onDelete: 'cascade' }),
    // jsonb('polygon') → text(mode:'json'): polygon vertex array.
    polygon: text('polygon', { mode: 'json' })
      .notNull()
      .$type<Array<{ xPct: number; yPct: number }>>(),
  },
  (t) => ({
    eventMapIdx: index('event_no_go_zones_event_map_idx').on(t.eventId, t.mapId),
  }),
)

export type DbEventNoGoZone = typeof eventNoGoZones.$inferSelect
export type DbEventNoGoZoneInsert = typeof eventNoGoZones.$inferInsert
