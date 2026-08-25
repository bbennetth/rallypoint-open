import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// food_items — the shared nutrition cache behind the food logger
// (issue #700). One row per known food: a barcode product resolved via
// Open Food Facts ('off'), an AI-estimated dish from a photo scan
// ('ai'), or a hand-entered food ('manual'). Macros are stored
// per-100g so any logged quantity scales linearly; servingGrams is a
// display hint ("1 bar = 45 g"), never used in math. `raw` keeps the
// upstream OFF payload for re-normalization without a re-fetch. Rows
// Open Food Facts rows are global (ownerUserId NULL). Reusable manual
// rows carry their private owner; createdBy remains provenance. id is
// `ff_<ulid>`.

export const foodItems = sqliteTable(
  'food_items',
  {
    id: text('id').primaryKey(),
    upc: text('upc'),
    source: text('source').notNull(), // 'off' | 'ai' | 'manual'
    name: text('name').notNull(),
    brand: text('brand'),
    servingGrams: real('serving_grams'),
    // Declared serving in its native basis (quantity + 'g'/'ml'), from
    // OFF's structured serving fields; servingGrams stays the derived
    // gram value. isLiquid (0/1, null = unknown/legacy) marks ml-basis
    // products so the UI can offer volume units (ml / fl oz / cup).
    servingQuantity: real('serving_quantity'),
    servingUnit: text('serving_unit'), // 'g' | 'ml'
    isLiquid: integer('is_liquid'),
    kcalPer100g: real('kcal_per_100g').notNull(),
    proteinPer100g: real('protein_per_100g').notNull(),
    carbsPer100g: real('carbs_per_100g').notNull(),
    fatPer100g: real('fat_per_100g').notNull(),
    raw: text('raw'),
    createdBy: text('created_by'),
    ownerUserId: text('owner_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    upcUq: uniqueIndex('food_items_upc_uq').on(t.upc),
    nameIdx: index('food_items_name_idx').on(t.name),
    ownerCustomNameUq: uniqueIndex('food_items_owner_custom_name_uq')
      .on(t.ownerUserId, sql`lower(${t.name})`)
      .where(sql`${t.ownerUserId} is not null and ${t.source} = 'manual'`),
  }),
)

export type DbFoodItem = typeof foodItems.$inferSelect
export type DbFoodItemInsert = typeof foodItems.$inferInsert
