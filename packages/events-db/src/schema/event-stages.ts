import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_stages — named stages/areas within an event (design §5.2).
// id is `evs_<ulid>`. Cascades when the parent event is hard-purged.
// (event_id, name) is unique so a stage name can't be duplicated
// within one event. Uniqueness is CASE-SENSITIVE on the raw name
// (unlike `artists`, which dedupes on lower(name)) — stage labels are
// short operator-chosen tokens where case can be meaningful, so do
// NOT add lower() here to "match the artist pattern". sort_order
// drives editor display order.

export const eventStages = sqliteTable(
  'event_stages',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    eventNameIdx: uniqueIndex('event_stages_event_name_idx').on(t.eventId, t.name),
  }),
)

export type DbEventStage = typeof eventStages.$inferSelect
export type DbEventStageInsert = typeof eventStages.$inferInsert
