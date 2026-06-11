import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_days — the calendar days an event spans (design §5.2). id is
// `evd_<ulid>`. day_label is the human tag ('WED', 'THU', 'Day 1'),
// date is the calendar date. Cascades when the parent event is
// hard-purged. Both (event_id, day_label) and (event_id, date) are
// unique — a day appears at most once under either key. sort_order
// drives editor/display ordering independent of date.
//
// start_time/end_time are the day's own optional window (24h 'HH:MM').
// Both null = an all-day date; both set = a timed window on that date.
// (These are the day's hours, distinct from event_sessions' per-activity
// times.) Consumers like Planner read these to place the day on a
// timeline; null times bucket as an all-day item.
//
// date('date') → text('date') ISO YYYY-MM-DD (same as lists-db convention).
// time('start_time')/time('end_time') → text(...) HH:MM:SS (same as lists-db convention).

export const eventDays = sqliteTable(
  'event_days',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    dayLabel: text('day_label').notNull(),
    // date('date') → text; ISO YYYY-MM-DD string.
    date: text('date').notNull(),
    // time('start_time')/time('end_time') → text; HH:MM:SS string.
    startTime: text('start_time'),
    endTime: text('end_time'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    eventLabelIdx: uniqueIndex('event_days_event_label_idx').on(t.eventId, t.dayLabel),
    eventDateIdx: uniqueIndex('event_days_event_date_idx').on(t.eventId, t.date),
  }),
)

export type DbEventDay = typeof eventDays.$inferSelect
export type DbEventDayInsert = typeof eventDays.$inferInsert
