import { sql } from 'drizzle-orm'
import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_maps — uploaded map images for an event (design §5.4). id is
// `emp_<ulid>`. Cascades when the parent event is hard-purged; the
// pruner additionally reaps the object-store bytes before the row
// delete (design §5.1.1). object_key is opaque
// (`event-maps/<event_id>/<map_id>.<ext>`) so listing the bucket
// reveals no PII. (event_id, layer) is unique — one map per layer
// (site|camp|full) per event. width/height are supplied by the client
// (it decodes the bitmap to place POIs) and stored for canvas scaling.
//
// bigint('bytes', { mode: 'number' }) → integer('bytes', { mode: 'number' }).
// bytes is a file size; values safely < 2^53, so integer(mode:'number') is fine.
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const eventMaps = sqliteTable(
  'event_maps',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    layer: text('layer').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    // bigint(mode:'number') → integer(mode:'number'): file size safely < 2^53.
    bytes: integer('bytes', { mode: 'number' }).notNull(),
    widthPx: integer('width_px').notNull(),
    heightPx: integer('height_px').notNull(),
    uploadedByUserId: text('uploaded_by_user_id').notNull(),
    uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    eventLayerIdx: uniqueIndex('event_maps_event_layer_idx').on(t.eventId, t.layer),
  }),
)

export type DbEventMap = typeof eventMaps.$inferSelect
export type DbEventMapInsert = typeof eventMaps.$inferInsert
