import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// recipe_ingredients — one ingredient line of a recipe, snapshotted from
// the prepared meal at "save as recipe" time (same shape as
// prepared_meal_ingredients, keyed on recipeId). Macros are the scaled
// snapshot at `grams`. id is `ri_<ulid>`.

export const recipeIngredients = sqliteTable(
  'recipe_ingredients',
  {
    id: text('id').primaryKey(),
    recipeId: text('recipe_id').notNull(),
    name: text('name').notNull(),
    brand: text('brand'),
    foodItemId: text('food_item_id'),
    grams: real('grams').notNull(),
    kcal: real('kcal').notNull(),
    proteinG: real('protein_g').notNull(),
    carbsG: real('carbs_g').notNull(),
    fatG: real('fat_g').notNull(),
    source: text('source').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    recipeIdx: index('recipe_ingredients_recipe_idx').on(t.recipeId),
  }),
)

export type DbRecipeIngredient = typeof recipeIngredients.$inferSelect
export type DbRecipeIngredientInsert = typeof recipeIngredients.$inferInsert
