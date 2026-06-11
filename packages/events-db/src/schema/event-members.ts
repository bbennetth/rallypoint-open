import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_members — collaborator join (design doc §5.1). id is
// `evm_<ulid>`. role is 'owner' | 'editor' | 'member'. user_id is a
// Rallypoint ID `user_<ulid>` (not FK'd). Cascades when the parent
// event is hard-purged. (event_id, user_id) is unique — a user holds
// at most one membership row per event.

export const eventMembers = sqliteTable(
  'event_members',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    eventUserIdx: uniqueIndex('event_members_event_user_idx').on(t.eventId, t.userId),
  }),
)

export type DbEventMember = typeof eventMembers.$inferSelect
export type DbEventMemberInsert = typeof eventMembers.$inferInsert
