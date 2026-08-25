import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// food_log_entries — a user's food diary (issue #700). One row per
// eaten thing at an instant; loggedAt is a client-supplied UTC instant
// (the Planner timezone rule — no stored per-user tz, the UI queries a
// client-computed day window). Macros are SNAPSHOTTED at log time
// (already scaled to quantityGrams) so later edits to the shared
// food_items cache never rewrite diary history; foodItemId is a soft
// provenance pointer, nullable for freeform/AI entries. source records
// how the entry was captured: 'barcode' | 'photo' | 'manual' | 'drink' |
// 'prepared_meal' (a portion logged from a meal-prep batch — see
// preparedMealId). id is `fl_<ulid>`.

export const foodLogEntries = sqliteTable(
  'food_log_entries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    loggedAt: integer('logged_at', { mode: 'timestamp_ms' }).notNull(),
    foodItemId: text('food_item_id'),
    name: text('name').notNull(),
    quantityGrams: real('quantity_grams'),
    // The unit + amount the user actually typed ("1.5 cup") —
    // quantityGrams stays canonical; this pair only re-opens the edit
    // sheet in the logged unit. Null on legacy rows.
    quantityUnit: text('quantity_unit'),
    quantityAmount: real('quantity_amount'),
    // Estimation tracking for photo entries: the RAW (pre-calibration)
    // meal-level AI gram estimate and the ai_traces response id of the
    // scan that produced it. quantityGrams is the actual the user
    // confirmed/weighed — the estimated-vs-actual pair lives on the row.
    // Null for barcode/manual entries and legacy rows.
    estimatedGrams: real('estimated_grams'),
    scanResponseId: text('scan_response_id'),
    // Provenance for a portion logged from a meal-prep batch: the
    // prepared_meals row this entry was decremented from. Null for all
    // ordinary diary entries. (Meal-prep tool.)
    preparedMealId: text('prepared_meal_id'),
    kcal: real('kcal').notNull(),
    proteinG: real('protein_g').notNull(),
    carbsG: real('carbs_g').notNull(),
    fatG: real('fat_g').notNull(),
    source: text('source').notNull(), // 'barcode' | 'photo' | 'manual'
    note: text('note'),
    // Dedupe key for a restored row (`ref = source row's id`), so
    // re-running a data import is a no-op. Nullable/opt-in, partial
    // unique per user — same contract as workouts.ref.
    ref: text('ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userLoggedIdx: index('food_log_entries_user_logged_idx').on(t.userId, t.loggedAt),
    userRefUq: uniqueIndex('fitness_food_log_entries_user_ref_uq')
      .on(t.userId, t.ref)
      .where(sql`${t.ref} is not null`),
  }),
)

export type DbFoodLogEntry = typeof foodLogEntries.$inferSelect
export type DbFoodLogEntryInsert = typeof foodLogEntries.$inferInsert
