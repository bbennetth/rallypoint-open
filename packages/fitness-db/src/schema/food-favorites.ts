import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// food_favorites — per-user pinned quick-log templates. A favorite is a
// SNAPSHOT taken from a diary row (name + quantity + macros), not a
// pointer to it: the source entry can be edited or deleted and the
// template still re-logs the thing the user actually pinned. That also
// makes freeform/AI entries pinnable, which a food_items join key could
// not express (food_log_entries.foodItemId is nullable).
//
// foodItemId rides along as soft provenance so a re-log can still link
// the diary row back to the shared cache; it is nulled rather than
// enforced when the cache row is gone. source is the original capture
// method, kept for the display badge only.
//
// No natural key, so no unique constraint: the API dedupes on
// (userId, name, quantityGrams, kcal) — the same triple the client's
// findFavoriteForEntry() uses to light up the pin toggle. id is
// `ffav_<ulid>`.

export const foodFavorites = sqliteTable(
  'food_favorites',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    foodItemId: text('food_item_id'),
    name: text('name').notNull(),
    quantityGrams: real('quantity_grams'),
    // The unit + amount the user typed when the pinned entry was logged
    // ("1.5 cup"); quantityGrams stays canonical. Null when the entry
    // was logged in plain grams.
    quantityUnit: text('quantity_unit'),
    quantityAmount: real('quantity_amount'),
    kcal: real('kcal').notNull(),
    proteinG: real('protein_g').notNull(),
    carbsG: real('carbs_g').notNull(),
    fatG: real('fat_g').notNull(),
    source: text('source').notNull(), // FoodLogSource of the pinned entry
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    // Drives the only read: the actor's list, newest pin first.
    userCreatedIdx: index('food_favorites_user_created_idx').on(t.userId, t.createdAt),
  }),
)

export type DbFoodFavorite = typeof foodFavorites.$inferSelect
export type DbFoodFavoriteInsert = typeof foodFavorites.$inferInsert
