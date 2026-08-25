import { describe, expect, it } from 'vitest'
import type {
  CreateFoodFavoriteInput,
  FoodFavoriteDto,
  PreparedMealDto,
  RecipeDto,
} from '@rallypoint/fitness-shared'
import type { FoodConfirmState } from './food-view.js'
import type { PreparedMealIngredientDto } from '@rallypoint/fitness-shared'
import {
  buildLogPortionPayload,
  findFavoriteForRecipe,
  recipeFavoriteInput,
  buildMealPrepIngredientEdit,
  buildMealPrepIngredientPayload,
  confirmStateFromIngredient,
  markFinishedWriteOff,
  mealPortionUnitCtx,
  per100gFromIngredient,
  photoIngredientProps,
  portionMacros,
} from './meal-prep-view.js'
import { MASS_ONLY_UNIT_CTX, type ScannedMealEstimate } from '@rallypoint/fitness-shared'

const confirmState = (o: Partial<FoodConfirmState> = {}): FoodConfirmState => ({
  name: 'Chicken',
  grams: '100',
  unit: 'g',
  amount: '100',
  kcal: '200',
  proteinG: '20',
  carbsG: '0',
  fatG: '5',
  note: '',
  ...o,
})

const meal = (o: Partial<PreparedMealDto> = {}): PreparedMealDto => ({
  id: 'pmeal_1',
  name: 'Chicken & rice',
  recipeId: null,
  status: 'active',
  totalGrams: 250,
  totalKcal: 500,
  totalProteinG: 15,
  totalCarbsG: 60,
  totalFatG: 17,
  gramsRemaining: 250,
  servings: 5,
  servingGrams: 50,
  servingsRemaining: 5,
  preparedAt: '2026-07-19T00:00:00.000Z',
  createdAt: '2026-07-19T00:00:00.000Z',
  ...o,
})

// A stored favorite row for a create input, as the API would echo it.
const synthFav = (input: CreateFoodFavoriteInput): FoodFavoriteDto => ({
  id: 'fav_1',
  foodItemId: input.foodItemId ?? null,
  name: input.name,
  quantityGrams: input.quantityGrams ?? null,
  quantityUnit: input.quantityUnit ?? null,
  quantityAmount: input.quantityAmount ?? null,
  kcal: input.kcal,
  proteinG: input.proteinG,
  carbsG: input.carbsG,
  fatG: input.fatG,
  source: input.source,
  createdAt: '2026-07-19T00:00:00.000Z',
})

describe('buildMealPrepIngredientPayload', () => {
  it('builds a payload with gramsAdded + source + provenance', () => {
    const r = buildMealPrepIngredientPayload(confirmState(), {
      source: 'barcode',
      foodItemId: 'ff_1',
      brand: 'Tyson',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({
      name: 'Chicken',
      gramsAdded: 100,
      kcal: 200,
      source: 'barcode',
      foodItemId: 'ff_1',
      brand: 'Tyson',
    })
  })
  it('requires positive grams (an ingredient must be weighed)', () => {
    const r = buildMealPrepIngredientPayload(confirmState({ grams: '', amount: '' }), {
      source: 'manual',
    })
    expect(r).toEqual({ ok: false, reason: 'bad_grams' })
  })
  it('requires a name', () => {
    const r = buildMealPrepIngredientPayload(confirmState({ name: '  ' }), { source: 'manual' })
    expect(r).toEqual({ ok: false, reason: 'missing_name' })
  })
  it('omits foodItemId/brand when absent', () => {
    const r = buildMealPrepIngredientPayload(confirmState(), { source: 'photo' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.foodItemId).toBeUndefined()
    expect(r.value.brand).toBeUndefined()
  })
})

describe('portionMacros', () => {
  it('scales the batch density to a portion', () => {
    // 50 g of a 200 kcal/100 g meal = 100 kcal
    expect(portionMacros(meal(), 50).kcal).toBe(100)
  })
})

describe('mealPortionUnitCtx', () => {
  it('offers serving when the batch has a serving count', () => {
    expect(mealPortionUnitCtx(meal()).servingGrams).toBe(50)
  })
  it('is mass-only for a weight-only batch', () => {
    expect(mealPortionUnitCtx(meal({ servings: null, servingGrams: null })).servingGrams).toBeNull()
  })
})

describe('buildLogPortionPayload', () => {
  it('logs by grams (no display pair)', () => {
    expect(buildLogPortionPayload(meal(), '50', 'g')).toEqual({
      ok: true,
      value: { quantityGrams: 50 },
    })
  })
  it('converts a serving to grams and keeps the display pair', () => {
    const r = buildLogPortionPayload(meal(), '1', 'serving')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ quantityGrams: 50, quantityUnit: 'serving', quantityAmount: 1 })
  })
  it('rejects an amount over what is left', () => {
    expect(buildLogPortionPayload(meal({ gramsRemaining: 40 }), '50', 'g')).toEqual({
      ok: false,
      reason: 'insufficient',
    })
  })
  it('allows logging exactly the remainder', () => {
    expect(buildLogPortionPayload(meal({ gramsRemaining: 50 }), '50', 'g').ok).toBe(true)
  })
  it('rejects a bad amount', () => {
    expect(buildLogPortionPayload(meal(), 'abc', 'g')).toEqual({ ok: false, reason: 'bad_amount' })
    expect(buildLogPortionPayload(meal(), '0', 'g')).toEqual({ ok: false, reason: 'bad_amount' })
  })
})

// --- editing an already-added ingredient ------------------------------

const ingredient = (o: Partial<PreparedMealIngredientDto> = {}): PreparedMealIngredientDto => ({
  id: 'pmi_1',
  name: 'Rice',
  brand: 'Lundberg',
  foodItemId: null,
  gramsAdded: 150,
  kcal: 300,
  proteinG: 6,
  carbsG: 60,
  fatG: 3,
  source: 'manual',
  createdAt: '2026-07-01T00:00:00.000Z',
  ...o,
})

describe('confirmStateFromIngredient', () => {
  it('prefills the sheet from the line snapshot, in grams', () => {
    expect(confirmStateFromIngredient(ingredient())).toEqual({
      name: 'Rice',
      grams: '150',
      unit: 'g',
      amount: '150',
      kcal: '300',
      proteinG: '6',
      carbsG: '60',
      fatG: '3',
      note: '',
    })
  })
})

describe('per100gFromIngredient', () => {
  it('derives density from the snapshot so amount edits rescale', () => {
    expect(per100gFromIngredient(ingredient())).toEqual({
      kcal: 200,
      proteinG: 4,
      carbsG: 40,
      fatG: 2,
    })
  })
  it('is null without a usable weight', () => {
    expect(per100gFromIngredient(ingredient({ gramsAdded: 0 }))).toBeNull()
  })
})

describe('buildMealPrepIngredientEdit', () => {
  it('builds the PATCH payload without source/foodItemId', () => {
    const r = buildMealPrepIngredientEdit(confirmState(), 'Kirkland')
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Chicken',
        brand: 'Kirkland',
        gramsAdded: 100,
        kcal: 200,
        proteinG: 20,
        carbsG: 0,
        fatG: 5,
      },
    })
  })
  it('omits brand when the line has none', () => {
    const r = buildMealPrepIngredientEdit(confirmState(), null)
    expect(r.ok && !('brand' in r.value)).toBe(true)
  })
  it('requires a weight (bad_grams) and a name', () => {
    expect(buildMealPrepIngredientEdit(confirmState({ grams: '', amount: '' }), null)).toEqual({
      ok: false,
      reason: 'bad_grams',
    })
    expect(buildMealPrepIngredientEdit(confirmState({ name: ' ' }), null)).toEqual({
      ok: false,
      reason: 'missing_name',
    })
  })
})

describe('markFinishedWriteOff', () => {
  it('counts in servings when the batch has a serving size', () => {
    expect(markFinishedWriteOff(meal({ gramsRemaining: 100, servingsRemaining: 2 }))).toBe(
      '2 servings (100 g)',
    )
  })
  it('singularises one serving', () => {
    expect(markFinishedWriteOff(meal({ gramsRemaining: 50, servingsRemaining: 1 }))).toBe(
      '1 serving (50 g)',
    )
  })
  it('keeps fractional servings as-is (users think in part-servings)', () => {
    expect(markFinishedWriteOff(meal({ gramsRemaining: 75, servingsRemaining: 1.5 }))).toBe(
      '1.5 servings (75 g)',
    )
  })
  it('falls back to grams on a weight-only batch', () => {
    expect(markFinishedWriteOff(meal({ gramsRemaining: 120, servingsRemaining: null }))).toBe(
      '120 g',
    )
  })
  it('falls back to grams when the remainder rounds under a tenth of a serving', () => {
    // servingsRemaining is 2dp, so a sliver of a huge serving can round to 0
    // — reporting "0 servings (5 g)" would read as nothing left.
    expect(markFinishedWriteOff(meal({ gramsRemaining: 5, servingsRemaining: 0 }))).toBe('5 g')
  })
  it('is null with nothing left to write off', () => {
    expect(markFinishedWriteOff(meal({ gramsRemaining: 0, servingsRemaining: 0 }))).toBeNull()
  })
})

describe('photoIngredientProps', () => {
  const MEAL: ScannedMealEstimate = {
    name: 'Ground beef',
    estimatedGrams: 450,
    estimatedServings: 3,
    servingGrams: 150,
    kcal: 900,
    proteinG: 80,
    carbsG: 0,
    fatG: 63,
    components: [],
  }

  it('prefills in grams, not servings — a recipe ingredient is weighed', () => {
    const p = photoIngredientProps(MEAL)
    expect(p.initial).toMatchObject({ grams: '450', unit: 'g', amount: '450', kcal: '900' })
    expect(p.unitCtx).toBe(MASS_ONLY_UNIT_CTX)
    expect(p.source).toBe('photo')
  })

  it('applies no portion bias — calibration is a diary-only concern', () => {
    const p = photoIngredientProps(MEAL)
    expect(p.initial.kcal).toBe(String(MEAL.kcal))
    expect(p.initial.grams).toBe(String(MEAL.estimatedGrams))
    expect(p).not.toHaveProperty('scanEstimate')
  })

  it('has no per100g to scale from at zero grams', () => {
    expect(photoIngredientProps({ ...MEAL, estimatedGrams: 0 }).per100g).toBeNull()
    expect(photoIngredientProps(MEAL).per100g).toEqual({
      kcal: 200,
      proteinG: 17.8,
      carbsG: 0,
      fatG: 14,
    })
  })
})

describe('quick-add pin (pre-defined meals)', () => {
  const recipe = (o: Partial<RecipeDto> = {}): RecipeDto => ({
    id: 'rcp_1',
    name: 'My breakfast',
    notes: null,
    yieldGrams: 320,
    servings: null,
    totalKcal: 410,
    totalProteinG: 28.5,
    totalCarbsG: 40,
    totalFatG: 12.3,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...o,
  })

  it('recipeFavoriteInput snapshots the whole-meal totals under the title', () => {
    expect(recipeFavoriteInput(recipe())).toEqual({
      name: 'My breakfast',
      quantityGrams: 320,
      kcal: 410,
      proteinG: 28.5,
      carbsG: 40,
      fatG: 12.3,
      source: 'manual',
    })
  })

  it('recipeFavoriteInput omits an unusable yield weight', () => {
    // quantityGrams has a 0.1 minimum server-side; a null/zero yield pins
    // weightless rather than failing the create.
    expect(recipeFavoriteInput(recipe({ yieldGrams: null })).quantityGrams).toBeUndefined()
    expect(recipeFavoriteInput(recipe({ yieldGrams: 0 })).quantityGrams).toBeUndefined()
  })

  it('findFavoriteForRecipe matches the pin identity, including weightless pins', () => {
    const pinned = synthFav(recipeFavoriteInput(recipe()))
    expect(findFavoriteForRecipe([pinned], recipe())).toBe(pinned)
    // Identity is name + grams + kcal: a renamed recipe no longer matches.
    expect(findFavoriteForRecipe([pinned], recipe({ name: 'Other' }))).toBeNull()
    expect(findFavoriteForRecipe([pinned], recipe({ yieldGrams: null }))).toBeNull()
    const weightless = recipe({ yieldGrams: null })
    const pinnedWeightless = synthFav(recipeFavoriteInput(weightless))
    expect(findFavoriteForRecipe([pinnedWeightless], weightless)).toBe(pinnedWeightless)
  })
})
