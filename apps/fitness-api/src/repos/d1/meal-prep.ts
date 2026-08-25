import { and, desc, eq, gte, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import {
  foodLogEntries,
  preparedMealIngredients,
  preparedMeals,
  recipeIngredients,
  recipes,
} from '@rallypoint/fitness-db'
import {
  preparedMealDensity,
  scaleMacros,
  PREPARED_MEAL_MIN_LOGGABLE_GRAMS,
  type FoodLogSource,
  type PreparedMealStatus,
} from '@rallypoint/fitness-shared'
import type {
  FinishPreparedMealResult,
  FoodLogEntryRecord,
  LogPreparedMealPortionInput,
  LogPreparedMealPortionResult,
  MarkPreparedMealFinishedResult,
  MealPrepMutation,
  MealPrepRepo,
  NewPreparedMeal,
  NewPreparedMealIngredient,
  NewRecipe,
  NewRecipeIngredient,
  PatchPreparedMealFields,
  PatchRecipeFields,
  PreparedMealIngredientRecord,
  PreparedMealListFilter,
  PreparedMealRecord,
  RecipeIngredientRecord,
  RecipeRecord,
  RecipeRepo,
  UpdateMealPrepIngredientFields,
  UpdateMealPrepIngredientResult,
} from '../types.js'
import type { Db } from './db.js'
import { chunkForBoundParams } from '@rallypoint/api-kit'

// Worst-case bound params per ingredient insert row (12 columns for both
// prepared_meal_ingredients and recipe_ingredients) — a large ingredient
// list in one multi-row VALUES would blow D1's 100-variable cap.
const INGREDIENT_INSERT_COLUMNS = 12

// Meal-prep repos (prepared-meal batches + recipes). Mirrors the food
// logger's batched-write style: D1 has no interactive transactions, so
// multi-row writes go through db.batch([...]) (sequential in one implicit
// transaction). Meal totals are maintained by re-summing the ingredient
// rows in the same batch as an add/remove, so concurrent adds converge.

type Stmt = BatchItem<'sqlite'>
type PreparedMealRow = typeof preparedMeals.$inferSelect
type PreparedMealIngredientRow = typeof preparedMealIngredients.$inferSelect
type RecipeRow = typeof recipes.$inferSelect
type RecipeIngredientRow = typeof recipeIngredients.$inferSelect

function mealRowToRecord(
  row: PreparedMealRow,
  ingredients?: PreparedMealIngredientRecord[],
): PreparedMealRecord {
  const rec: PreparedMealRecord = {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    recipeId: row.recipeId ?? null,
    status: row.status as PreparedMealStatus,
    totalGrams: row.totalGrams,
    totalKcal: row.totalKcal,
    totalProteinG: row.totalProteinG,
    totalCarbsG: row.totalCarbsG,
    totalFatG: row.totalFatG,
    gramsRemaining: row.gramsRemaining,
    servings: row.servings ?? null,
    preparedAt: row.preparedAt ?? null,
    createdAt: row.createdAt,
  }
  if (ingredients) rec.ingredients = ingredients
  return rec
}

function ingredientRowToRecord(row: PreparedMealIngredientRow): PreparedMealIngredientRecord {
  return {
    id: row.id,
    preparedMealId: row.preparedMealId,
    name: row.name,
    brand: row.brand ?? null,
    foodItemId: row.foodItemId ?? null,
    gramsAdded: row.gramsAdded,
    kcal: row.kcal,
    proteinG: row.proteinG,
    carbsG: row.carbsG,
    fatG: row.fatG,
    source: row.source as FoodLogSource,
    createdAt: row.createdAt,
  }
}

function ingredientInsertRow(
  ing: NewPreparedMealIngredient,
  now: Date,
): typeof preparedMealIngredients.$inferInsert {
  return {
    id: ing.id,
    preparedMealId: ing.preparedMealId,
    name: ing.name,
    brand: ing.brand ?? null,
    foodItemId: ing.foodItemId ?? null,
    gramsAdded: ing.gramsAdded,
    kcal: ing.kcal,
    proteinG: ing.proteinG,
    carbsG: ing.carbsG,
    fatG: ing.fatG,
    source: ing.source,
    createdAt: now,
  }
}

export class D1MealPrepRepo implements MealPrepRepo {
  constructor(private readonly db: Db) {}

  async listForActor(
    userId: string,
    filter: PreparedMealListFilter,
  ): Promise<PreparedMealRecord[]> {
    const conds = [eq(preparedMeals.ownerUserId, userId)]
    if (filter.status) conds.push(eq(preparedMeals.status, filter.status))
    const rows = await this.db
      .select()
      .from(preparedMeals)
      .where(and(...conds))
      .orderBy(desc(preparedMeals.createdAt))
      .limit(Math.min(filter.limit ?? 100, 500))
    return rows.map((r) => mealRowToRecord(r))
  }

  async getForActor(userId: string, id: string): Promise<PreparedMealRecord | null> {
    const row = await this.mealRow(userId, id)
    if (!row) return null
    const ingRows = await this.db
      .select()
      .from(preparedMealIngredients)
      .where(eq(preparedMealIngredients.preparedMealId, id))
      .orderBy(preparedMealIngredients.createdAt)
    return mealRowToRecord(row, ingRows.map(ingredientRowToRecord))
  }

  // Lightweight owner-scoped read (no ingredients) for guard checks.
  private async mealRow(userId: string, id: string): Promise<PreparedMealRow | null> {
    const rows = await this.db
      .select()
      .from(preparedMeals)
      .where(and(eq(preparedMeals.id, id), eq(preparedMeals.ownerUserId, userId)))
      .limit(1)
    return rows[0] ?? null
  }

  // The "re-sum the ingredient rows into the meal totals" UPDATE, run in the
  // same batch right after an add/remove so its subquery sees that write.
  // GUARDED on status='cooking': if a concurrent finish() flipped the meal
  // between the caller's status read and this write, it matches 0 rows —
  // the caller inspects meta.changes to detect that race and bail, so a
  // post-finish add/remove can't silently desync totals from gramsRemaining.
  private refreshTotalsStmt(mealId: string): Stmt {
    return this.db
      .update(preparedMeals)
      .set({
        totalGrams: sql`(select coalesce(sum(${preparedMealIngredients.gramsAdded}), 0) from ${preparedMealIngredients} where ${preparedMealIngredients.preparedMealId} = ${mealId})`,
        totalKcal: sql`(select coalesce(sum(${preparedMealIngredients.kcal}), 0) from ${preparedMealIngredients} where ${preparedMealIngredients.preparedMealId} = ${mealId})`,
        totalProteinG: sql`(select coalesce(sum(${preparedMealIngredients.proteinG}), 0) from ${preparedMealIngredients} where ${preparedMealIngredients.preparedMealId} = ${mealId})`,
        totalCarbsG: sql`(select coalesce(sum(${preparedMealIngredients.carbsG}), 0) from ${preparedMealIngredients} where ${preparedMealIngredients.preparedMealId} = ${mealId})`,
        totalFatG: sql`(select coalesce(sum(${preparedMealIngredients.fatG}), 0) from ${preparedMealIngredients} where ${preparedMealIngredients.preparedMealId} = ${mealId})`,
      })
      .where(and(eq(preparedMeals.id, mealId), eq(preparedMeals.status, 'cooking'))) as Stmt
  }

  async create(
    input: NewPreparedMeal,
    ingredients: NewPreparedMealIngredient[] = [],
  ): Promise<PreparedMealRecord> {
    const now = new Date()
    // Pre-sum totals for a recipe-cloned batch (empty → all zeros).
    let totalGrams = 0
    let totalKcal = 0
    let totalProteinG = 0
    let totalCarbsG = 0
    let totalFatG = 0
    for (const i of ingredients) {
      totalGrams += i.gramsAdded
      totalKcal += i.kcal
      totalProteinG += i.proteinG
      totalCarbsG += i.carbsG
      totalFatG += i.fatG
    }
    const mealRow: typeof preparedMeals.$inferInsert = {
      id: input.id,
      ownerUserId: input.ownerUserId,
      name: input.name,
      recipeId: input.recipeId ?? null,
      status: 'cooking',
      totalGrams,
      totalKcal,
      totalProteinG,
      totalCarbsG,
      totalFatG,
      // gramsRemaining stays 0 until finish seeds it = totalGrams.
      gramsRemaining: 0,
      servings: input.servings ?? null,
      preparedAt: null,
      createdAt: now,
    }
    if (ingredients.length === 0) {
      await this.db.insert(preparedMeals).values(mealRow)
    } else {
      const stmts: [Stmt, ...Stmt[]] = [this.db.insert(preparedMeals).values(mealRow) as Stmt]
      const rows = ingredients.map((i) => ingredientInsertRow(i, now))
      for (const chunk of chunkForBoundParams(rows, INGREDIENT_INSERT_COLUMNS)) {
        stmts.push(this.db.insert(preparedMealIngredients).values(chunk) as Stmt)
      }
      await this.db.batch(stmts)
    }
    const created = await this.getForActor(input.ownerUserId, input.id)
    return created!
  }

  async addIngredient(
    userId: string,
    mealId: string,
    ingredient: NewPreparedMealIngredient,
  ): Promise<MealPrepMutation> {
    const meal = await this.mealRow(userId, mealId)
    if (!meal) return { ok: false, reason: 'not_found' }
    if (meal.status !== 'cooking') return { ok: false, reason: 'not_cooking' }
    const now = new Date()
    // Force the FK to the path meal id regardless of what the caller passed.
    const row = ingredientInsertRow({ ...ingredient, preparedMealId: mealId }, now)
    const insertIng = this.db.insert(preparedMealIngredients).values(row) as Stmt
    // refreshTotalsStmt is guarded on status='cooking'. If a concurrent
    // finish() flipped the meal to 'active' between the read above and this
    // batch, the refresh matches 0 rows while the (unguardable-in-batch)
    // insert still commits — so compensate by removing the orphan row and
    // report the meal as no-longer-cooking.
    const res = await this.db.batch([insertIng, this.refreshTotalsStmt(mealId)])
    if ((res[1]?.meta?.changes ?? 0) === 0) {
      await this.db.delete(preparedMealIngredients).where(eq(preparedMealIngredients.id, row.id))
      return { ok: false, reason: 'not_cooking' }
    }
    const updated = await this.getForActor(userId, mealId)
    return { ok: true, meal: updated! }
  }

  async updateIngredient(
    userId: string,
    mealId: string,
    ingredientId: string,
    fields: UpdateMealPrepIngredientFields,
  ): Promise<UpdateMealPrepIngredientResult> {
    const meal = await this.mealRow(userId, mealId)
    if (!meal) return { ok: false, reason: 'not_found' }
    if (meal.status !== 'cooking') return { ok: false, reason: 'not_cooking' }
    // Same race pattern as removeIngredient: both the update and the totals
    // refresh are guarded on the meal still being 'cooking', so a concurrent
    // finish() in the read→write gap can't mutate a frozen meal.
    const upd = this.db
      .update(preparedMealIngredients)
      .set({
        name: fields.name,
        brand: fields.brand,
        gramsAdded: fields.gramsAdded,
        kcal: fields.kcal,
        proteinG: fields.proteinG,
        carbsG: fields.carbsG,
        fatG: fields.fatG,
      })
      .where(
        and(
          eq(preparedMealIngredients.id, ingredientId),
          eq(preparedMealIngredients.preparedMealId, mealId),
          sql`exists (select 1 from ${preparedMeals} where ${preparedMeals.id} = ${mealId} and ${preparedMeals.status} = 'cooking')`,
        ),
      ) as Stmt
    const res = await this.db.batch([upd, this.refreshTotalsStmt(mealId)])
    if ((res[1]?.meta?.changes ?? 0) === 0) return { ok: false, reason: 'not_cooking' }
    if ((res[0]?.meta?.changes ?? 0) === 0) return { ok: false, reason: 'ingredient_not_found' }
    const updated = await this.getForActor(userId, mealId)
    return { ok: true, meal: updated! }
  }

  async removeIngredient(
    userId: string,
    mealId: string,
    ingredientId: string,
  ): Promise<MealPrepMutation> {
    const meal = await this.mealRow(userId, mealId)
    if (!meal) return { ok: false, reason: 'not_found' }
    if (meal.status !== 'cooking') return { ok: false, reason: 'not_cooking' }
    // Guard the delete (and the refresh below) on the meal still being
    // 'cooking', so a finish() landing in the read→write gap can't mutate a
    // frozen meal. Both matching 0 rows ⇒ the race happened; report it.
    const del = this.db
      .delete(preparedMealIngredients)
      .where(
        and(
          eq(preparedMealIngredients.id, ingredientId),
          eq(preparedMealIngredients.preparedMealId, mealId),
          sql`exists (select 1 from ${preparedMeals} where ${preparedMeals.id} = ${mealId} and ${preparedMeals.status} = 'cooking')`,
        ),
      ) as Stmt
    const res = await this.db.batch([del, this.refreshTotalsStmt(mealId)])
    if ((res[1]?.meta?.changes ?? 0) === 0) return { ok: false, reason: 'not_cooking' }
    const updated = await this.getForActor(userId, mealId)
    return { ok: true, meal: updated! }
  }

  async finish(
    userId: string,
    mealId: string,
    servings: number | null,
    now: Date,
  ): Promise<FinishPreparedMealResult> {
    const meal = await this.mealRow(userId, mealId)
    if (!meal) return { ok: false, reason: 'not_found' }
    if (meal.status !== 'cooking') return { ok: false, reason: 'not_cooking' }
    if (!(meal.totalGrams > 0)) return { ok: false, reason: 'empty' }
    await this.db
      .update(preparedMeals)
      .set({
        status: 'active',
        // Seed the remaining counter from the live total_grams column.
        gramsRemaining: sql`${preparedMeals.totalGrams}`,
        servings: servings ?? null,
        preparedAt: now,
      })
      .where(
        and(
          eq(preparedMeals.id, mealId),
          eq(preparedMeals.ownerUserId, userId),
          eq(preparedMeals.status, 'cooking'),
        ),
      )
    const updated = await this.getForActor(userId, mealId)
    return { ok: true, meal: updated! }
  }

  async markFinished(userId: string, mealId: string): Promise<MarkPreparedMealFinishedResult> {
    // Same guarded-update shape as logPortion (status='active' in the WHERE,
    // RETURNING to see whether we won), minus the diary insert: writing the
    // batch off is explicitly NOT eating it, so no food_log_entries row and
    // no macros are attributed to the user. gramsRemaining zeroes to keep
    // the 'finished' ⇔ nothing-left invariant the DTO derivations assume.
    const updatedRows = await this.db
      .update(preparedMeals)
      .set({ status: 'finished', gramsRemaining: 0 })
      .where(
        and(
          eq(preparedMeals.id, mealId),
          eq(preparedMeals.ownerUserId, userId),
          eq(preparedMeals.status, 'active'),
        ),
      )
      .returning()
    if (updatedRows.length === 0) {
      // Distinguish "no such meal for this actor" from "wrong status" — the
      // route maps them to 404 vs 409.
      const fresh = await this.mealRow(userId, mealId)
      return { ok: false, reason: fresh ? 'not_active' : 'not_found' }
    }
    const updated = await this.getForActor(userId, mealId)
    return { ok: true, meal: updated! }
  }

  async logPortion(
    userId: string,
    mealId: string,
    portion: LogPreparedMealPortionInput,
    now: Date,
  ): Promise<LogPreparedMealPortionResult> {
    const meal = await this.mealRow(userId, mealId)
    if (!meal) return { ok: false, reason: 'not_found' }
    if (meal.status !== 'active') return { ok: false, reason: 'not_active' }
    const g = portion.quantityGrams

    // Race-safe guarded decrement: only matches while still 'active' AND with
    // enough remaining, so two concurrent logs can't both pass. RETURNING
    // tells us whether we won (empty ⇒ someone else drained it first). Any
    // remainder that would drop BELOW the minimum loggable portion rounds the
    // batch to 0 + 'finished' — otherwise a sub-minimum residue (which the
    // portion schema's min then rejects) would strand it forever in 'active'.
    const updatedRows = await this.db
      .update(preparedMeals)
      .set({
        gramsRemaining: sql`case when ${preparedMeals.gramsRemaining} - ${g} < ${PREPARED_MEAL_MIN_LOGGABLE_GRAMS} then 0 else ${preparedMeals.gramsRemaining} - ${g} end`,
        status: sql`case when ${preparedMeals.gramsRemaining} - ${g} < ${PREPARED_MEAL_MIN_LOGGABLE_GRAMS} then 'finished' else ${preparedMeals.status} end`,
      })
      .where(
        and(
          eq(preparedMeals.id, mealId),
          eq(preparedMeals.ownerUserId, userId),
          eq(preparedMeals.status, 'active'),
          gte(preparedMeals.gramsRemaining, g),
        ),
      )
      .returning()
    if (updatedRows.length === 0) {
      // Re-read so the reported "available" reflects the current remainder
      // (a concurrent log may have moved it since the guard read above).
      const fresh = await this.mealRow(userId, mealId)
      // The guard covers status AND remainder, so a 0-row match has two
      // causes. Discriminate on the fresh status: a concurrent markFinished
      // (or a log that drained the batch) in the read→write gap left it
      // no-longer-active, and "Only 0 g left in this meal." would misreport
      // that as an over-request.
      if (fresh && fresh.status !== 'active') return { ok: false, reason: 'not_active' }
      return {
        ok: false,
        reason: 'insufficient_remaining',
        availableGrams: fresh?.gramsRemaining ?? meal.gramsRemaining,
      }
    }

    // Macros derived from the meal's own density (server never trusts client
    // macro math). The diary insert is a separate statement — a crash between
    // the decrement and this insert is the only (rare, accepted) non-atomic
    // window; the guard above still prevents over-consumption.
    const macros = scaleMacros(preparedMealDensity(meal), g)
    const entryRow: typeof foodLogEntries.$inferInsert = {
      id: portion.entryId,
      userId,
      loggedAt: portion.loggedAt,
      name: meal.name,
      quantityGrams: g,
      quantityUnit: portion.quantityUnit ?? null,
      quantityAmount: portion.quantityAmount ?? null,
      preparedMealId: mealId,
      kcal: macros.kcal,
      proteinG: macros.proteinG,
      carbsG: macros.carbsG,
      fatG: macros.fatG,
      source: 'prepared_meal',
      note: portion.note ?? null,
      createdAt: now,
    }
    await this.db.insert(foodLogEntries).values(entryRow)

    const updatedMeal = await this.getForActor(userId, mealId)
    const entry: FoodLogEntryRecord = {
      id: portion.entryId,
      userId,
      loggedAt: portion.loggedAt,
      foodItemId: null,
      name: meal.name,
      quantityGrams: g,
      quantityUnit: portion.quantityUnit ?? null,
      quantityAmount: portion.quantityAmount ?? null,
      estimatedGrams: null,
      scanResponseId: null,
      preparedMealId: mealId,
      kcal: macros.kcal,
      proteinG: macros.proteinG,
      carbsG: macros.carbsG,
      fatG: macros.fatG,
      source: 'prepared_meal',
      note: portion.note ?? null,
      createdAt: now,
    }
    return { ok: true, meal: updatedMeal!, entry }
  }

  async patch(
    userId: string,
    mealId: string,
    fields: PatchPreparedMealFields,
  ): Promise<PreparedMealRecord | null> {
    const meal = await this.mealRow(userId, mealId)
    if (!meal) return null
    const set: Record<string, unknown> = {}
    if (fields.name !== undefined) set.name = fields.name
    if ('servings' in fields) set.servings = fields.servings ?? null
    if (Object.keys(set).length > 0) {
      await this.db
        .update(preparedMeals)
        .set(set)
        .where(and(eq(preparedMeals.id, mealId), eq(preparedMeals.ownerUserId, userId)))
    }
    return this.getForActor(userId, mealId)
  }

  async delete(userId: string, mealId: string): Promise<boolean> {
    const meal = await this.mealRow(userId, mealId)
    if (!meal) return false
    // Hard delete + cascade the ingredient rows (no FK, so delete both),
    // atomic in one batch. Owner scope re-checked on the meal delete.
    const res = await this.db.batch([
      this.db
        .delete(preparedMealIngredients)
        .where(eq(preparedMealIngredients.preparedMealId, mealId)),
      this.db
        .delete(preparedMeals)
        .where(and(eq(preparedMeals.id, mealId), eq(preparedMeals.ownerUserId, userId))),
    ])
    return (res[1]?.meta?.changes ?? 0) > 0
  }
}

// --- recipes ----------------------------------------------------------

function recipeRowToRecord(row: RecipeRow, ingredients?: RecipeIngredientRecord[]): RecipeRecord {
  const rec: RecipeRecord = {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    notes: row.notes ?? null,
    yieldGrams: row.yieldGrams ?? null,
    servings: row.servings ?? null,
    totalKcal: row.totalKcal,
    totalProteinG: row.totalProteinG,
    totalCarbsG: row.totalCarbsG,
    totalFatG: row.totalFatG,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (ingredients) rec.ingredients = ingredients
  return rec
}

function recipeIngredientRowToRecord(row: RecipeIngredientRow): RecipeIngredientRecord {
  return {
    id: row.id,
    recipeId: row.recipeId,
    name: row.name,
    brand: row.brand ?? null,
    foodItemId: row.foodItemId ?? null,
    grams: row.grams,
    kcal: row.kcal,
    proteinG: row.proteinG,
    carbsG: row.carbsG,
    fatG: row.fatG,
    source: row.source as FoodLogSource,
    createdAt: row.createdAt,
  }
}

function recipeIngredientInsertRow(
  i: NewRecipeIngredient,
  now: Date,
): typeof recipeIngredients.$inferInsert {
  return {
    id: i.id,
    recipeId: i.recipeId,
    name: i.name,
    brand: i.brand ?? null,
    foodItemId: i.foodItemId ?? null,
    grams: i.grams,
    kcal: i.kcal,
    proteinG: i.proteinG,
    carbsG: i.carbsG,
    fatG: i.fatG,
    source: i.source,
    createdAt: now,
  }
}

export class D1RecipeRepo implements RecipeRepo {
  constructor(private readonly db: Db) {}

  async listForActor(userId: string): Promise<RecipeRecord[]> {
    const rows = await this.db
      .select()
      .from(recipes)
      .where(eq(recipes.ownerUserId, userId))
      .orderBy(desc(recipes.updatedAt))
      .limit(500)
    return rows.map((r) => recipeRowToRecord(r))
  }

  async getForActor(userId: string, id: string): Promise<RecipeRecord | null> {
    const rows = await this.db
      .select()
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.ownerUserId, userId)))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    const ingRows = await this.db
      .select()
      .from(recipeIngredients)
      .where(eq(recipeIngredients.recipeId, id))
      .orderBy(recipeIngredients.createdAt)
    return recipeRowToRecord(row, ingRows.map(recipeIngredientRowToRecord))
  }

  async create(input: NewRecipe, ingredients: NewRecipeIngredient[]): Promise<RecipeRecord> {
    const now = new Date()
    const recipeRow: typeof recipes.$inferInsert = {
      id: input.id,
      ownerUserId: input.ownerUserId,
      name: input.name,
      notes: input.notes ?? null,
      yieldGrams: input.yieldGrams ?? null,
      servings: input.servings ?? null,
      totalKcal: input.totalKcal,
      totalProteinG: input.totalProteinG,
      totalCarbsG: input.totalCarbsG,
      totalFatG: input.totalFatG,
      createdAt: now,
      updatedAt: now,
    }
    if (ingredients.length === 0) {
      await this.db.insert(recipes).values(recipeRow)
    } else {
      const stmts: [Stmt, ...Stmt[]] = [this.db.insert(recipes).values(recipeRow) as Stmt]
      const rows = ingredients.map((i) => recipeIngredientInsertRow(i, now))
      for (const chunk of chunkForBoundParams(rows, INGREDIENT_INSERT_COLUMNS)) {
        stmts.push(this.db.insert(recipeIngredients).values(chunk) as Stmt)
      }
      await this.db.batch(stmts)
    }
    const created = await this.getForActor(input.ownerUserId, input.id)
    return created!
  }

  async patch(
    userId: string,
    id: string,
    fields: PatchRecipeFields,
  ): Promise<RecipeRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    if ('notes' in fields) set.notes = fields.notes ?? null
    if ('servings' in fields) set.servings = fields.servings ?? null
    const rows = await this.db
      .update(recipes)
      .set(set)
      .where(and(eq(recipes.id, id), eq(recipes.ownerUserId, userId)))
      .returning()
    return rows[0] ? recipeRowToRecord(rows[0]) : null
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.ownerUserId, userId)))
      .limit(1)
    if (rows.length === 0) return false
    const res = await this.db.batch([
      this.db.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, id)),
      this.db.delete(recipes).where(and(eq(recipes.id, id), eq(recipes.ownerUserId, userId))),
    ])
    return (res[1]?.meta?.changes ?? 0) > 0
  }
}
