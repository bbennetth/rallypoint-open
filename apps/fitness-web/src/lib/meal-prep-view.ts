import {
  findFavoriteForEntry,
  formatScannedComponent,
  preparedMealDensity,
  scaleMacros,
  toGrams,
  MASS_ONLY_UNIT_CTX,
  type CreateFoodFavoriteInput,
  type CreateMealPrepIngredientInput,
  type FoodFavoriteDto,
  type FoodLogSource,
  type FoodQuantityUnit,
  type FoodUnitContext,
  type MacrosPer100g,
  type PreparedMealDto,
  type PreparedMealIngredientDto,
  type RecipeDto,
  type ScannedMealEstimate,
  type UpdateMealPrepIngredientInput,
} from '@rallypoint/fitness-shared'
import { buildFoodPayload, type FoodConfirmState } from './food-view.js'

// Pure view logic for the meal-prep tool. Reuses the food logger's
// confirm-sheet form (FoodConfirmState + applyAmountEdit/applyUnitSwitch
// from food-view.ts) for the add-ingredient flow, and adds the portion-
// logging math for a finished batch.

export type BuildMealPrepIngredientResult =
  | { ok: true; value: CreateMealPrepIngredientInput }
  | { ok: false; reason: 'missing_name' | 'bad_macros' | 'bad_grams' }

/** Build the add-ingredient payload from the confirm sheet. Reuses the
 *  food logger's validation (buildFoodPayload), but grams is REQUIRED for
 *  a cooked ingredient — an absent quantity is bad_grams. source + optional
 *  foodItemId/brand ride from the scan hit that produced the ingredient. */
export function buildMealPrepIngredientPayload(
  state: FoodConfirmState,
  meta: { source: FoodLogSource; foodItemId?: string | null; brand?: string | null },
): BuildMealPrepIngredientResult {
  const base = buildFoodPayload(state)
  if (!base.ok) return base
  if (base.value.quantityGrams === undefined) return { ok: false, reason: 'bad_grams' }
  const value: CreateMealPrepIngredientInput = {
    name: base.value.name,
    gramsAdded: base.value.quantityGrams,
    kcal: base.value.kcal,
    proteinG: base.value.proteinG,
    carbsG: base.value.carbsG,
    fatG: base.value.fatG,
    source: meta.source,
  }
  if (meta.foodItemId) value.foodItemId = meta.foodItemId
  if (meta.brand) value.brand = meta.brand
  return { ok: true, value }
}

// --- editing an already-added ingredient ------------------------------

/** Prefill the confirm sheet from an existing ingredient line. Always
 *  opens in grams (the canonical stored quantity — the original unit the
 *  user typed isn't snapshotted on the line). */
export function confirmStateFromIngredient(ing: PreparedMealIngredientDto): FoodConfirmState {
  return {
    name: ing.name,
    grams: String(ing.gramsAdded),
    unit: 'g',
    amount: String(ing.gramsAdded),
    kcal: String(ing.kcal),
    proteinG: String(ing.proteinG),
    carbsG: String(ing.carbsG),
    fatG: String(ing.fatG),
    note: '',
  }
}

/** Per-100g density from the ingredient's own snapshot so quantity edits
 *  re-scale macros in the sheet (same trick as per100gFromEntry). Null
 *  when the line has no usable weight — macros stay directly editable. */
/** Photo-scan estimate → add-ingredient sheet props. Unlike the diary's
 *  photoConfirmProps this applies NO portion bias: calibration is a
 *  diary-only concern (it's learned from logged corrections), and a recipe
 *  ingredient is weighed, not estimated by eye. Grams, not servings. */
export function photoIngredientProps(meal: ScannedMealEstimate) {
  return {
    title: 'Add ingredient',
    initial: {
      name: meal.name,
      grams: String(meal.estimatedGrams),
      unit: 'g' as const,
      amount: String(meal.estimatedGrams),
      kcal: String(meal.kcal),
      proteinG: String(meal.proteinG),
      carbsG: String(meal.carbsG),
      fatG: String(meal.fatG),
      note: '',
    },
    source: 'photo' as const,
    per100g:
      meal.estimatedGrams > 0
        ? scaleMacros(
            { kcal: meal.kcal, proteinG: meal.proteinG, carbsG: meal.carbsG, fatG: meal.fatG },
            10000 / meal.estimatedGrams,
          )
        : null,
    unitCtx: MASS_ONLY_UNIT_CTX,
    estimateNotice: 'AI estimate — check the numbers before adding.',
    components: meal.components.map(formatScannedComponent),
  }
}

export function per100gFromIngredient(ing: PreparedMealIngredientDto): MacrosPer100g | null {
  if (!(ing.gramsAdded > 0)) return null
  return scaleMacros(
    { kcal: ing.kcal, proteinG: ing.proteinG, carbsG: ing.carbsG, fatG: ing.fatG },
    10000 / ing.gramsAdded,
  )
}

export type BuildMealPrepIngredientEditResult =
  | { ok: true; value: UpdateMealPrepIngredientInput }
  | { ok: false; reason: 'missing_name' | 'bad_macros' | 'bad_grams' }

/** Build the edit (PATCH) payload from the confirm sheet — the create
 *  builder minus the frozen source/foodItemId meta. brand rides through
 *  unchanged from the line being edited. */
export function buildMealPrepIngredientEdit(
  state: FoodConfirmState,
  brand: string | null,
): BuildMealPrepIngredientEditResult {
  const base = buildFoodPayload(state)
  if (!base.ok) return base
  if (base.value.quantityGrams === undefined) return { ok: false, reason: 'bad_grams' }
  const value: UpdateMealPrepIngredientInput = {
    name: base.value.name,
    gramsAdded: base.value.quantityGrams,
    kcal: base.value.kcal,
    proteinG: base.value.proteinG,
    carbsG: base.value.carbsG,
    fatG: base.value.fatG,
  }
  if (brand) value.brand = brand
  return { ok: true, value }
}

// --- portion logging (finished batch) ---------------------------------

// A prepared meal is never liquid; the unit picker offers g / oz, plus
// 'serving' once the batch has a serving count (servingGrams derived).
export function mealPortionUnitCtx(meal: PreparedMealDto): FoodUnitContext {
  if (meal.servingGrams !== null && meal.servingGrams > 0) {
    return { servingGrams: meal.servingGrams, isLiquid: false }
  }
  return MASS_ONLY_UNIT_CTX
}

/** Macros for a portion of `grams` from a batch — the meal's own per-100g
 *  density scaled to the amount. Drives the log sheet's live preview
 *  (the server derives the persisted macros the same way). */
export function portionMacros(meal: PreparedMealDto, grams: number): MacrosPer100g {
  return scaleMacros(preparedMealDensity(meal), grams)
}

// --- writing a batch off ("mark finished") ----------------------------

/** Confirm-dialog copy for marking an active batch finished: what's about
 *  to be written off, in the unit the user tracks this batch in (servings
 *  when the batch has a serving count, grams otherwise). Null when there's
 *  nothing left to write off — the batch drains to 'finished' on its own at
 *  that point, so the dialog drops the write-off sentence entirely rather
 *  than claiming "0 g will be marked as not eaten". */
export function markFinishedWriteOff(
  meal: Pick<PreparedMealDto, 'gramsRemaining' | 'servingsRemaining'>,
): string | null {
  if (!(meal.gramsRemaining > 0)) return null
  const grams = `${meal.gramsRemaining} g`
  const s = meal.servingsRemaining
  if (s === null || !(s > 0)) return grams
  return `${s} serving${s === 1 ? '' : 's'} (${grams})`
}

export type BuildLogPortionResult =
  | {
      ok: true
      value: { quantityGrams: number; quantityUnit?: FoodQuantityUnit; quantityAmount?: number }
    }
  | { ok: false; reason: 'bad_amount' | 'insufficient' }

/** Convert the log-portion form (amount + unit) into the canonical
 *  quantityGrams payload, converting serving/oz via the batch's serving
 *  size. Rejects a non-positive amount and one that exceeds what's left
 *  (the server guards this too; this is the immediate client feedback). */
export function buildLogPortionPayload(
  meal: PreparedMealDto,
  amountStr: string,
  unit: FoodQuantityUnit,
): BuildLogPortionResult {
  const amount = Number(amountStr)
  if (amountStr.trim() === '' || !isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'bad_amount' }
  }
  const grams = toGrams(amount, unit, mealPortionUnitCtx(meal))
  if (grams === null || grams <= 0) return { ok: false, reason: 'bad_amount' }
  // Small epsilon so logging exactly the remainder isn't rejected by float
  // dust (the server clamps ≤ 0.05 g to a clean finish).
  if (grams > meal.gramsRemaining + 0.05) return { ok: false, reason: 'insufficient' }
  const value: { quantityGrams: number; quantityUnit?: FoodQuantityUnit; quantityAmount?: number } = {
    quantityGrams: grams,
  }
  if (unit !== 'g') {
    value.quantityUnit = unit
    value.quantityAmount = amount
  }
  return { ok: true, value }
}

// --- pin to quick add (pre-defined meals) -----------------------------
// A "pre-defined meal" is a recipe (the durable per-ingredient breakdown)
// pinned to the food quick-add as a favorite snapshot of its totals under
// the user's title. Logging the pin writes ONE aggregated diary row via
// the favorite confirm sheet.

/** Favorite snapshot for pinning a saved recipe to the food quick-add.
 *  The pin is the WHOLE meal's totals — the confirm sheet's per-100g
 *  rescaling covers logging a fraction. Source is 'manual': re-logging a
 *  template is neither a fresh scan nor a batch portion (mirrors
 *  favoriteToLogEntry's 'prepared_meal' → 'manual' degrade). */
export function recipeFavoriteInput(recipe: RecipeDto): CreateFoodFavoriteInput {
  return {
    name: recipe.name,
    ...(recipe.yieldGrams !== null && recipe.yieldGrams > 0
      ? { quantityGrams: recipe.yieldGrams }
      : {}),
    kcal: recipe.totalKcal,
    proteinG: recipe.totalProteinG,
    carbsG: recipe.totalCarbsG,
    fatG: recipe.totalFatG,
    source: 'manual',
  }
}

/** The favorite matching a recipe's pin, or null — drives the Pin/Unpin
 *  toggle with the same snapshot identity the API dedupes creates on
 *  (foodFavoriteKey: name + grams + kcal). Must stay consistent with
 *  recipeFavoriteInput's omit-when-unusable quantity rule. */
export function findFavoriteForRecipe(
  favorites: readonly FoodFavoriteDto[],
  recipe: RecipeDto,
): FoodFavoriteDto | null {
  return findFavoriteForEntry(favorites, {
    name: recipe.name,
    quantityGrams:
      recipe.yieldGrams !== null && recipe.yieldGrams > 0 ? recipe.yieldGrams : null,
    kcal: recipe.totalKcal,
  })
}
