import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// recipes — a reusable meal template saved from a prepared meal ("save as
// recipe"). Ingredient lines are an immutable one-time snapshot in v1
// (name/notes/servings are patchable; the lines are not). "Cook from
// recipe" clones the lines into a fresh prepared_meals batch the user can
// adjust. Macro totals are snapshotted so the recipe card renders without
// re-summing recipe_ingredients. id is `rcp_<ulid>`.

export const recipes = sqliteTable(
  'recipes',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').notNull(),
    name: text('name').notNull(),
    notes: text('notes'),
    // Total cooked weight of the recipe + its serving count (both nullable;
    // servings drives the derived serving size when cooked from it).
    yieldGrams: real('yield_grams'),
    servings: real('servings'),
    totalKcal: real('total_kcal').notNull().default(0),
    totalProteinG: real('total_protein_g').notNull().default(0),
    totalCarbsG: real('total_carbs_g').notNull().default(0),
    totalFatG: real('total_fat_g').notNull().default(0),
    // Dedupe key for a restored row (`ref = source row's id`) — see
    // food_log_entries.ref.
    ref: text('ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    ownerIdx: index('recipes_owner_idx').on(t.ownerUserId),
    ownerRefUq: uniqueIndex('fitness_recipes_owner_ref_uq')
      .on(t.ownerUserId, t.ref)
      .where(sql`${t.ref} is not null`),
  }),
)

export type DbRecipe = typeof recipes.$inferSelect
export type DbRecipeInsert = typeof recipes.$inferInsert
