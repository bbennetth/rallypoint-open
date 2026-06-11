import { sql } from 'drizzle-orm'
import { sqliteTable, foreignKey, primaryKey, text, integer } from 'drizzle-orm/sqlite-core'
import { lists } from './lists.js'

// list_planner_prefs — per-user "show in planner" flag for a list.
//
// Composite PK (list_id, user_id): one row per user per list.
// show_in_planner defaults to true so an explicit upsert(show=true)
// is idempotent on a brand-new row. user_id is a `user_<ulid>`
// cross-schema reference (not FK'd), same convention as list_shares.
//
// FK list_id → lists.id ON DELETE CASCADE: when a list is hard-purged
// its pref rows vanish with it; soft-deleted lists are visible until
// the pruner hard-purges them (the app layer skips deleted lists in the
// planner-lists read anyway).
//
// updated_at uses (unixepoch()*1000) sentinel (timestamp_ms pattern),
// matching events-db star/attendee convention.

export const listPlannerPrefs = sqliteTable(
  'list_planner_prefs',
  {
    listId: text('list_id').notNull(),
    userId: text('user_id').notNull(),
    showInPlanner: integer('show_in_planner', { mode: 'boolean' }).notNull().default(true),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.listId, t.userId] }),
    listFk: foreignKey({
      columns: [t.listId],
      foreignColumns: [lists.id],
      name: 'list_planner_prefs_list_fk',
    }).onDelete('cascade'),
  }),
)

export type DbListPlannerPref = typeof listPlannerPrefs.$inferSelect
export type DbListPlannerPrefInsert = typeof listPlannerPrefs.$inferInsert
