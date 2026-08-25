import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// prepared_meals — a batch of food cooked from scanned ingredients (the
// meal-prep tool). While `status = 'cooking'` the user is still scanning
// ingredients into it (a live draft that survives a refresh / phone-lock);
// on finish it flips to 'active' with grams_remaining seeded to total_grams
// and an optional user-set serving count, then the user logs portions from
// it (by weight or serving) until grams_remaining hits 0 and it
// auto-'finished'. Macro + gram totals are maintained incrementally as
// ingredients are added/removed (see repos/d1/meal-prep.ts). recipeId
// records the recipe it was cooked from, if any. id is `pmeal_<ulid>`.

export const preparedMeals = sqliteTable(
  'prepared_meals',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').notNull(),
    name: text('name').notNull(),
    // Provenance: the recipe this batch was cooked from (null = ad-hoc).
    recipeId: text('recipe_id'),
    // 'cooking' (still adding ingredients) | 'active' (finished cooking,
    // being eaten down) | 'finished' (grams_remaining exhausted).
    status: text('status').notNull().default('cooking'),
    totalGrams: real('total_grams').notNull().default(0),
    totalKcal: real('total_kcal').notNull().default(0),
    totalProteinG: real('total_protein_g').notNull().default(0),
    totalCarbsG: real('total_carbs_g').notNull().default(0),
    totalFatG: real('total_fat_g').notNull().default(0),
    // Canonical "until it's gone" counter: set = total_grams at finish and
    // decremented per logged portion. Servings are DERIVED for display
    // (serving size = total_grams / servings) — never a second counter.
    gramsRemaining: real('grams_remaining').notNull().default(0),
    // User-set serving count (null = weight-only). serving size =
    // total_grams / servings; remaining servings = grams_remaining / size.
    servings: real('servings'),
    // Set when cooking finishes (status → 'active').
    preparedAt: integer('prepared_at', { mode: 'timestamp_ms' }),
    // Dedupe key for a restored row (`ref = source row's id`) — see
    // food_log_entries.ref.
    ref: text('ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    ownerStatusIdx: index('prepared_meals_owner_status_idx').on(t.ownerUserId, t.status),
    ownerRefUq: uniqueIndex('fitness_prepared_meals_owner_ref_uq')
      .on(t.ownerUserId, t.ref)
      .where(sql`${t.ref} is not null`),
  }),
)

export type DbPreparedMeal = typeof preparedMeals.$inferSelect
export type DbPreparedMealInsert = typeof preparedMeals.$inferInsert
