import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// prepared_meal_ingredients — one scanned ingredient added to a prepared
// meal while cooking. Macros are the SNAPSHOT scaled to gramsAdded (like
// food_log_entries), not per-100g, so summing the meal total is trivial and
// later food_items edits never rewrite a cooked meal. foodItemId is a soft
// provenance pointer (nullable for AI/manual ingredients). source mirrors
// FoodLogSource. id is `pmi_<ulid>`.

export const preparedMealIngredients = sqliteTable(
  'prepared_meal_ingredients',
  {
    id: text('id').primaryKey(),
    preparedMealId: text('prepared_meal_id').notNull(),
    name: text('name').notNull(),
    brand: text('brand'),
    foodItemId: text('food_item_id'),
    gramsAdded: real('grams_added').notNull(),
    kcal: real('kcal').notNull(),
    proteinG: real('protein_g').notNull(),
    carbsG: real('carbs_g').notNull(),
    fatG: real('fat_g').notNull(),
    source: text('source').notNull(), // FoodLogSource: 'barcode' | 'photo' | 'manual' | ...
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    mealIdx: index('prepared_meal_ingredients_meal_idx').on(t.preparedMealId),
  }),
)

export type DbPreparedMealIngredient = typeof preparedMealIngredients.$inferSelect
export type DbPreparedMealIngredientInsert = typeof preparedMealIngredients.$inferInsert
