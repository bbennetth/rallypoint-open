import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// muscle_groups — the top level of the 2-level training-practical muscle
// taxonomy (Legs/Back/Chest/Shoulders/Arms/Core). A small fixed reference
// set seeded from @rallypoint/fitness-shared, so the PK is a stable human
// slug ('leg', 'back', ...) rather than a ULID — slugs are referenced
// directly by the seed and by muscles.group_id. `sort` drives display
// order in the catalog filter UI.

export const muscleGroups = sqliteTable('muscle_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
})

export type DbMuscleGroup = typeof muscleGroups.$inferSelect
export type DbMuscleGroupInsert = typeof muscleGroups.$inferInsert
