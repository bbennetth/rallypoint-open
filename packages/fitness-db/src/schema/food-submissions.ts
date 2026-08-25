import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// food_submissions — a user's AI nutrition-label UPC contribution,
// pending admin review before it's promoted into the global, shared
// `food_items` cache. Mirrors exercise_submissions in shape/convention
// (see exercise-submissions.ts) but carries a snapshot of the scanned
// label rather than pointing at an existing catalog row: the
// contribution is a brand-new global candidate, not a promotion of an
// existing private row (the private food_items row it's logged against
// never carries the upc — see routes/food.ts saveAsUpc notes).
//
// Approval creates (or links to) a global `food_items` row and OFFERS the
// submitter a one-time migration of their diary entry + deletion of the
// interim private row onto the global one, which only runs if they
// accept (migration_status). id is `fdsub_<ulid>`.
//
// Only one PENDING submission may exist per upc at a time (the partial
// unique index below) — a second user scanning the same unknown barcode
// while a review is in flight logs against a private row instead of
// creating a second submission (see routes/food.ts). Multiple past
// approved/rejected submissions for the same upc are fine (e.g.
// resubmit after a rejection).

export const foodSubmissions = sqliteTable(
  'food_submissions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    upc: text('upc').notNull(),
    privateFoodItemId: text('private_food_item_id').notNull(),
    // Snapshot of the reviewed label read at submission time — the
    // global row (on approval) and the admin DTO are built from these
    // columns, not a live join to the private food_items row (which is
    // deleted once the migration is accepted).
    name: text('name').notNull(),
    brand: text('brand'),
    servingGrams: real('serving_grams').notNull(),
    servingQuantity: real('serving_quantity').notNull(),
    servingUnit: text('serving_unit').notNull(),
    isLiquid: integer('is_liquid').notNull(),
    kcalPer100g: real('kcal_per_100g').notNull(),
    proteinPer100g: real('protein_per_100g').notNull(),
    carbsPer100g: real('carbs_per_100g').notNull(),
    fatPer100g: real('fat_per_100g').notNull(),
    // pending | approved | rejected
    status: text('status').notNull().default('pending'),
    adminNote: text('admin_note'),
    globalFoodItemId: text('global_food_item_id'),
    // none | offered | accepted | declined
    migrationStatus: text('migration_status').notNull().default('none'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
    migratedAt: integer('migrated_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('food_submissions_user_idx').on(t.userId),
    statusIdx: index('food_submissions_status_idx').on(t.status),
    // At most one PENDING submission per upc — guards the double-submit
    // race the same way exercise_submissions' per-exercise index does.
    // Not expressible with a simple column-set unique index since it
    // must exclude non-pending rows (a resubmit after rejection must be
    // allowed to create a new row).
    pendingUpcUq: uniqueIndex('food_submissions_pending_upc_uq')
      .on(t.upc)
      .where(sql`${t.status} = 'pending'`),
  }),
)

export type DbFoodSubmission = typeof foodSubmissions.$inferSelect
export type DbFoodSubmissionInsert = typeof foodSubmissions.$inferInsert
