import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { muscleGroups } from './muscle-groups.js'

// muscles — the leaf level of the muscle taxonomy (quads, lats, delts,
// ...). ~19 rows seeded from @rallypoint/fitness-shared. Slug PK for the
// same reason as muscle_groups (referenced by name from the seed +
// exercise_muscles.muscle_id). Each muscle belongs to exactly one group;
// the front/side/rear delt + lats/traps/rhomboids/erectors splits are what
// make per-muscle balance insights honest (slice 4 volume aggregation).

export const muscles = sqliteTable(
  'muscles',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => muscleGroups.id),
    name: text('name').notNull(),
    sort: integer('sort').notNull().default(0),
  },
  (t) => ({
    groupIdx: index('muscles_group_idx').on(t.groupId),
  }),
)

export type DbMuscle = typeof muscles.$inferSelect
export type DbMuscleInsert = typeof muscles.$inferInsert
