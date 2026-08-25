import { z } from 'zod'
import {
  FOOD_LOG_SOURCES,
  macroFields,
  refineQuantityPair,
  type FoodLogSource,
  type MacrosPer100g,
} from './food.js'
import { FOOD_QUANTITY_UNITS } from './food-units.js'

// Meal-prep vocabulary + pure logic, shared by apps/fitness-api and
// apps/fitness-web. Layers on the food logger: you scan ingredients into a
// prepared-meal batch while cooking, finish it with a total weight +
// optional serving count, then log portions from it (by weight or serving)
// until it's gone. Macros are snapshotted per-ingredient (scaled to grams)
// exactly like food_log_entries, so summing a meal is trivial and the
// per-100g density used to scale a logged portion is derived from the
// totals. "Save as recipe" snapshots the ingredient lines into a reusable
// recipe you can cook from later.

export const PREPARED_MEAL_STATUSES = ['cooking', 'active', 'finished'] as const
export type PreparedMealStatus = (typeof PREPARED_MEAL_STATUSES)[number]

// --- DTOs -------------------------------------------------------------

// One ingredient snapshot on a prepared meal. Macros are already scaled to
// gramsAdded (not per-100g). foodItemId is a soft provenance pointer to the
// food_items cache, null for AI/photo/manual ingredients.
export interface PreparedMealIngredientDto {
  id: string
  name: string
  brand: string | null
  foodItemId: string | null
  gramsAdded: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
  createdAt: string
}

export interface PreparedMealDto {
  id: string
  name: string
  // The recipe this batch was cooked from, if any.
  recipeId: string | null
  status: PreparedMealStatus
  totalGrams: number
  totalKcal: number
  totalProteinG: number
  totalCarbsG: number
  totalFatG: number
  // Canonical "until it's gone" counter (grams). Equals totalGrams right
  // after finish, ticks down per logged portion, 0 when finished.
  gramsRemaining: number
  // User-set serving count (null = weight-only meal).
  servings: number | null
  // Derived (servings present): grams in one serving = totalGrams/servings.
  // Drives the log-by-serving unit conversion + the "1 of N servings" UI.
  servingGrams: number | null
  // Derived (servings present): servings still remaining.
  servingsRemaining: number | null
  // Set when cooking finished (status left 'cooking').
  preparedAt: string | null
  createdAt: string
  // Present on the detail read; omitted from list rows.
  ingredients?: PreparedMealIngredientDto[]
}

export interface RecipeIngredientDto {
  id: string
  name: string
  brand: string | null
  foodItemId: string | null
  grams: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
}

export interface RecipeDto {
  id: string
  name: string
  notes: string | null
  yieldGrams: number | null
  servings: number | null
  totalKcal: number
  totalProteinG: number
  totalCarbsG: number
  totalFatG: number
  createdAt: string
  updatedAt: string
  // Present on the detail read; omitted from list rows.
  ingredients?: RecipeIngredientDto[]
}

// --- aggregation math (point 2: "total calories per gram/oz/etc") -----

export interface MealTotals {
  totalGrams: number
  totalKcal: number
  totalProteinG: number
  totalCarbsG: number
  totalFatG: number
}

// The per-ingredient snapshot fields aggregateMeal needs.
export interface IngredientMacros {
  gramsAdded: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
}

/** Sum ingredient snapshots into meal totals. Exact (no extra rounding):
 *  the repo maintains the stored totals with the same SQL SUM over the
 *  already-rounded per-ingredient values, and the DTO layer rounds for
 *  display — so a batch cloned from a recipe (pre-summed here) and one
 *  built ingredient-by-ingredient (SQL-summed) agree. */
export function aggregateMeal(ingredients: IngredientMacros[]): MealTotals {
  let totalGrams = 0
  let totalKcal = 0
  let totalProteinG = 0
  let totalCarbsG = 0
  let totalFatG = 0
  for (const it of ingredients) {
    totalGrams += it.gramsAdded
    totalKcal += it.kcal
    totalProteinG += it.proteinG
    totalCarbsG += it.carbsG
    totalFatG += it.fatG
  }
  return { totalGrams, totalKcal, totalProteinG, totalCarbsG, totalFatG }
}

/** The meal's per-100g macro density, for scaling a logged portion via
 *  scaleMacros. All-zero macros when totalGrams <= 0 (an empty or
 *  not-yet-cooked batch) rather than dividing by zero. Unrounded — the
 *  caller (scaleMacros) rounds the scaled portion. */
export function preparedMealDensity(totals: MealTotals): MacrosPer100g {
  if (!(totals.totalGrams > 0)) return { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }
  const f = 100 / totals.totalGrams
  return {
    kcal: totals.totalKcal * f,
    proteinG: totals.totalProteinG * f,
    carbsG: totals.totalCarbsG * f,
    fatG: totals.totalFatG * f,
  }
}

/** Grams in one serving (totalGrams / servings, 1 dp), or null when the
 *  meal has no serving count or a non-positive total/servings. This is the
 *  gram factor the log-by-serving unit conversion uses. */
export function mealServingGrams(totalGrams: number, servings: number | null): number | null {
  if (servings === null || !(servings > 0) || !(totalGrams > 0)) return null
  return Math.round((totalGrams / servings) * 10) / 10
}

/** Servings still remaining (gramsRemaining / servingGrams, 2 dp — users
 *  think of servings fractionally), or null when the serving size is
 *  unknown. Clamps to 0 at/under empty. */
export function remainingServings(
  gramsRemaining: number,
  servingGrams: number | null,
): number | null {
  if (servingGrams === null || !(servingGrams > 0)) return null
  if (gramsRemaining <= 0) return 0
  return Math.round((gramsRemaining / servingGrams) * 100) / 100
}

// --- validators -------------------------------------------------------

// Smallest loggable portion (grams). Load-bearing: the batch auto-finishes
// once the remainder drops BELOW this, so a sub-minimum residue (which the
// portion schema's min would otherwise make un-loggable) can never strand a
// batch in 'active'. The repo's decrement CASE references the same value.
export const PREPARED_MEAL_MIN_LOGGABLE_GRAMS = 0.1

export const createPreparedMealSchema = z.object({
  // Optional at start-of-cook; the server defaults a placeholder name when
  // absent and no recipe is given.
  name: z.string().trim().min(1).max(200).optional(),
  // When set, clone the recipe's ingredient lines into the new batch.
  fromRecipeId: z.string().max(60).optional(),
})
export type CreatePreparedMealInput = z.infer<typeof createPreparedMealSchema>

// One scanned ingredient added to a cooking meal. Macros are the snapshot
// at gramsAdded (client-computed from the confirm sheet, bounded here —
// same trust model as the diary). Unlike the diary, the meal-prep path
// does NOT contribute to the shared food_items cache in v1: an ingredient
// only carries a soft foodItemId when it came from an existing cache row
// (barcode/search); AI/photo reads snapshot macros without a global write.
export const createMealPrepIngredientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  brand: z.string().trim().min(1).max(200).nullish(),
  foodItemId: z.string().max(60).optional(),
  gramsAdded: z.number().finite().min(0.1).max(20000),
  ...macroFields,
  source: z.enum(FOOD_LOG_SOURCES),
})
export type CreateMealPrepIngredientInput = z.infer<typeof createMealPrepIngredientSchema>

// Edit an ingredient on a cooking meal: full replacement of the editable
// snapshot fields. source and foodItemId are frozen — they record where the
// ingredient came from, which editing the numbers doesn't change.
export const updateMealPrepIngredientSchema = createMealPrepIngredientSchema.omit({
  foodItemId: true,
  source: true,
})
export type UpdateMealPrepIngredientInput = z.infer<typeof updateMealPrepIngredientSchema>

export const finishPreparedMealSchema = z.object({
  // Optional serving count. null/absent → weight-only meal.
  servings: z.number().finite().positive().max(1000).nullish(),
})
export type FinishPreparedMealInput = z.infer<typeof finishPreparedMealSchema>

export const patchPreparedMealSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  servings: z.number().finite().positive().max(1000).nullish(),
})
export type PatchPreparedMealInput = z.infer<typeof patchPreparedMealSchema>

// Log a portion of a finished ('active') batch. quantityGrams is the
// canonical amount (client converts from serving/oz using the meal's
// servingGrams via toGrams); the unit/amount pair only records what the
// user picked so the diary row reads "1 serving". Macros are NOT sent —
// the server derives them from the meal density × grams.
export const logPreparedMealPortionSchema = z
  .object({
    loggedAt: z.string().datetime(),
    quantityGrams: z.number().finite().min(PREPARED_MEAL_MIN_LOGGABLE_GRAMS).max(20000),
    quantityUnit: z.enum(FOOD_QUANTITY_UNITS).optional(),
    quantityAmount: z.number().finite().positive().max(20000).optional(),
    note: z.string().max(2000).optional(),
  })
  .superRefine(refineQuantityPair)
export type LogPreparedMealPortionInput = z.infer<typeof logPreparedMealPortionSchema>

export const saveAsRecipeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  notes: z.string().max(2000).optional(),
  servings: z.number().finite().positive().max(1000).nullish(),
})
export type SaveAsRecipeInput = z.infer<typeof saveAsRecipeSchema>

export const patchRecipeSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(2000).nullish(),
  servings: z.number().finite().positive().max(1000).nullish(),
})
export type PatchRecipeInput = z.infer<typeof patchRecipeSchema>
