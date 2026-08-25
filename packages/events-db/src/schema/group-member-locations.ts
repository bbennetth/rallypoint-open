import { sql } from 'drizzle-orm'
import { sqliteTable, text, real, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { groups } from './groups.js'

// group_member_locations — a member's self-placed pin on the event's
// image map, shown to the rest of the group ("crew pins" on the attendee
// Map tab). id is `gml_<ulid>`. Not GPS: the member taps the map, so the
// position is a percentage on one map layer ('site' | 'camp' | 'full').
// A row's existence means the member has a pin; removing the pin deletes
// the row (no sharing flag). user_id is a Rallypoint ID `user_<ulid>`
// (not FK'd — cross-schema). Cascades with the group. (group_id, user_id)
// unique — one pin per member per group.
//
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const groupMemberLocations = sqliteTable(
  'group_member_locations',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    layer: text('layer').notNull(),
    xPct: real('x_pct').notNull(),
    yPct: real('y_pct').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    groupUserIdx: uniqueIndex('group_member_locations_group_user_idx').on(t.groupId, t.userId),
  }),
)

export type DbGroupMemberLocation = typeof groupMemberLocations.$inferSelect
export type DbGroupMemberLocationInsert = typeof groupMemberLocations.$inferInsert
