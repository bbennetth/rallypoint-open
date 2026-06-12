import { sql } from 'drizzle-orm'
import { sqliteTable, index, text, integer } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'
import { eventDays } from './event-days.js'
import { eventStages } from './event-stages.js'
import { groups } from './groups.js'

// event_sessions — schedulable activities within an event (design §5.3).
// id is `evx_<ulid>` (note `evs_` is taken by event_stages). Cascades
// when the parent event is hard-purged; day_id is SET NULL when its day
// is removed so a session survives losing its assigned day.
//
// approval_status drives the per-event approval workflow: owners create
// sessions pre-approved ('approved'); editors submit them as 'pending'
// for an owner to approve/reject. visibility retains the festival-planner
// vocabulary ('admin'|'private'|'group'|'custom') — 'admin' now means
// "event-owner-only", 'group' means "group-scoped". group_id FK→groups.id
// is SET NULL on group deletion so a session survives losing its group
// scope; group-scoped visibility filtering on reads remains deferred.
// shared_with holds user_ids when visibility='custom'.
//
// time('start_time')/time('end_time') → text; HH:MM:SS string.
// jsonb('shared_with') → text(mode:'json').
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const eventSessions = sqliteTable(
  'event_sessions',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    dayId: text('day_id').references(() => eventDays.id, { onDelete: 'set null' }),
    // Sessions can be held at a stage (#215, lineup parity). SET NULL on
    // stage deletion so a session survives losing its stage, same as
    // event_artists.stage_id.
    stageId: text('stage_id').references(() => eventStages.id, { onDelete: 'set null' }),
    // time('start_time')/time('end_time') → text; HH:MM:SS string.
    startTime: text('start_time'),
    endTime: text('end_time'),
    category: text('category'),
    host: text('host'),
    approvalStatus: text('approval_status').notNull().default('approved'),
    visibility: text('visibility').notNull().default('group'),
    groupId: text('group_id').references(() => groups.id, { onDelete: 'set null' }),
    // jsonb('shared_with') → text(mode:'json'); nullable, no default.
    sharedWith: text('shared_with', { mode: 'json' }).$type<string[]>(),
    createdByUserId: text('created_by_user_id').notNull(),
    submittedByUserId: text('submitted_by_user_id'),
    approvedByUserId: text('approved_by_user_id'),
    // timestamp({ withTimezone }) → integer(mode:'timestamp_ms').
    approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    eventDayIdx: index('event_sessions_event_day_idx').on(t.eventId, t.dayId),
  }),
)

export type DbEventSession = typeof eventSessions.$inferSelect
export type DbEventSessionInsert = typeof eventSessions.$inferInsert
