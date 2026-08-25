import { describe, expect, it } from 'vitest'
import { scaleMacros } from './food.js'
import {
  aggregateMeal,
  createMealPrepIngredientSchema,
  updateMealPrepIngredientSchema,
  createPreparedMealSchema,
  finishPreparedMealSchema,
  logPreparedMealPortionSchema,
  mealServingGrams,
  preparedMealDensity,
  remainingServings,
  saveAsRecipeSchema,
  type IngredientMacros,
} from './meal-prep.js'

const ing = (o: Partial<IngredientMacros>): IngredientMacros => ({
  gramsAdded: 0,
  kcal: 0,
  proteinG: 0,
  carbsG: 0,
  fatG: 0,
  ...o,
})

describe('aggregateMeal', () => {
  it('returns all zeros for an empty meal', () => {
    expect(aggregateMeal([])).toEqual({
      totalGrams: 0,
      totalKcal: 0,
      totalProteinG: 0,
      totalCarbsG: 0,
      totalFatG: 0,
    })
  })

  it('sums each ingredient field', () => {
    const totals = aggregateMeal([
      ing({ gramsAdded: 100, kcal: 200, proteinG: 10, carbsG: 20, fatG: 5 }),
      ing({ gramsAdded: 150, kcal: 300, proteinG: 5, carbsG: 40, fatG: 12 }),
    ])
    expect(totals).toEqual({
      totalGrams: 250,
      totalKcal: 500,
      totalProteinG: 15,
      totalCarbsG: 60,
      totalFatG: 17,
    })
  })
})

describe('preparedMealDensity', () => {
  it('returns zero macros when the meal has no grams (empty / not cooked)', () => {
    expect(
      preparedMealDensity({
        totalGrams: 0,
        totalKcal: 0,
        totalProteinG: 0,
        totalCarbsG: 0,
        totalFatG: 0,
      }),
    ).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 })
  })

  it('never divides by zero even if kcal is somehow non-zero at zero grams', () => {
    const d = preparedMealDensity({
      totalGrams: 0,
      totalKcal: 500,
      totalProteinG: 5,
      totalCarbsG: 5,
      totalFatG: 5,
    })
    expect(d).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 })
  })

  it('computes per-100g density from the totals', () => {
    const d = preparedMealDensity({
      totalGrams: 250,
      totalKcal: 500,
      totalProteinG: 15,
      totalCarbsG: 60,
      totalFatG: 17,
    })
    // 500 kcal / 250 g × 100 = 200 kcal per 100 g.
    expect(d.kcal).toBeCloseTo(200)
    expect(d.proteinG).toBeCloseTo(6)
    expect(d.carbsG).toBeCloseTo(24)
    expect(d.fatG).toBeCloseTo(6.8)
  })

  it('scaling the density by a portion reproduces the whole-meal totals', () => {
    const totals = { totalGrams: 250, totalKcal: 500, totalProteinG: 15, totalCarbsG: 60, totalFatG: 17 }
    // Logging the entire 250 g back out must land on the meal totals.
    const portion = scaleMacros(preparedMealDensity(totals), 250)
    expect(portion.kcal).toBe(500)
    expect(portion.proteinG).toBeCloseTo(15)
    expect(portion.carbsG).toBeCloseTo(60)
    expect(portion.fatG).toBeCloseTo(17)
  })
})

describe('mealServingGrams', () => {
  it('is null without a serving count', () => {
    expect(mealServingGrams(500, null)).toBeNull()
  })
  it('is null for non-positive servings or total', () => {
    expect(mealServingGrams(500, 0)).toBeNull()
    expect(mealServingGrams(0, 5)).toBeNull()
  })
  it('divides total weight by the serving count (1 dp)', () => {
    expect(mealServingGrams(500, 4)).toBe(125)
    expect(mealServingGrams(500, 3)).toBe(166.7)
  })
})

describe('remainingServings', () => {
  it('is null without a known serving size', () => {
    expect(remainingServings(300, null)).toBeNull()
  })
  it('clamps to 0 at/under empty', () => {
    expect(remainingServings(0, 125)).toBe(0)
    expect(remainingServings(-5, 125)).toBe(0)
  })
  it('divides remaining weight by the serving size (2 dp)', () => {
    expect(remainingServings(250, 125)).toBe(2)
    expect(remainingServings(300, 125)).toBe(2.4)
  })
})

describe('logPreparedMealPortionSchema', () => {
  it('accepts a grams-only portion', () => {
    const r = logPreparedMealPortionSchema.safeParse({
      loggedAt: '2026-07-19T12:00:00.000Z',
      quantityGrams: 125,
    })
    expect(r.success).toBe(true)
  })
  it('accepts a serving portion with the display pair', () => {
    const r = logPreparedMealPortionSchema.safeParse({
      loggedAt: '2026-07-19T12:00:00.000Z',
      quantityGrams: 125,
      quantityUnit: 'serving',
      quantityAmount: 1,
    })
    expect(r.success).toBe(true)
  })
  it('rejects a unit without its amount', () => {
    const r = logPreparedMealPortionSchema.safeParse({
      loggedAt: '2026-07-19T12:00:00.000Z',
      quantityGrams: 125,
      quantityUnit: 'serving',
    })
    expect(r.success).toBe(false)
  })
  it('rejects a non-positive amount', () => {
    const r = logPreparedMealPortionSchema.safeParse({
      loggedAt: '2026-07-19T12:00:00.000Z',
      quantityGrams: 0,
    })
    expect(r.success).toBe(false)
  })
})

describe('createMealPrepIngredientSchema', () => {
  it('accepts a scanned ingredient snapshot', () => {
    const r = createMealPrepIngredientSchema.safeParse({
      name: 'Chicken breast',
      gramsAdded: 200,
      kcal: 330,
      proteinG: 62,
      carbsG: 0,
      fatG: 7,
      source: 'barcode',
    })
    expect(r.success).toBe(true)
  })
  it('requires positive grams', () => {
    const r = createMealPrepIngredientSchema.safeParse({
      name: 'Chicken breast',
      gramsAdded: 0,
      kcal: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      source: 'manual',
    })
    expect(r.success).toBe(false)
  })
  it('rejects an unknown source', () => {
    const r = createMealPrepIngredientSchema.safeParse({
      name: 'x',
      gramsAdded: 10,
      kcal: 1,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      source: 'nope',
    })
    expect(r.success).toBe(false)
  })
})

describe('updateMealPrepIngredientSchema', () => {
  const base = { name: 'Chicken', gramsAdded: 200, kcal: 330, proteinG: 62, carbsG: 0, fatG: 7 }
  it('accepts an edit without source/foodItemId (frozen fields)', () => {
    expect(updateMealPrepIngredientSchema.safeParse(base).success).toBe(true)
    expect(updateMealPrepIngredientSchema.safeParse({ ...base, brand: 'Kirkland' }).success).toBe(true)
  })
  it('strips a source/foodItemId if sent (not editable)', () => {
    const r = updateMealPrepIngredientSchema.safeParse({
      ...base,
      source: 'barcode',
      foodItemId: 'ff_x',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect('source' in r.data).toBe(false)
      expect('foodItemId' in r.data).toBe(false)
    }
  })
  it('keeps the create bounds (positive grams, non-negative macros, name)', () => {
    expect(updateMealPrepIngredientSchema.safeParse({ ...base, gramsAdded: 0 }).success).toBe(false)
    expect(updateMealPrepIngredientSchema.safeParse({ ...base, kcal: -1 }).success).toBe(false)
    expect(updateMealPrepIngredientSchema.safeParse({ ...base, name: '' }).success).toBe(false)
  })
})

describe('finishPreparedMealSchema', () => {
  it('accepts an omitted serving count (weight-only)', () => {
    expect(finishPreparedMealSchema.safeParse({}).success).toBe(true)
  })
  it('accepts an explicit null serving count', () => {
    expect(finishPreparedMealSchema.safeParse({ servings: null }).success).toBe(true)
  })
  it('rejects a non-positive serving count', () => {
    expect(finishPreparedMealSchema.safeParse({ servings: 0 }).success).toBe(false)
  })
})

describe('createPreparedMealSchema / saveAsRecipeSchema', () => {
  it('allows an empty create body (fresh unnamed cook)', () => {
    expect(createPreparedMealSchema.safeParse({}).success).toBe(true)
  })
  it('requires a recipe name', () => {
    expect(saveAsRecipeSchema.safeParse({}).success).toBe(false)
    expect(saveAsRecipeSchema.safeParse({ name: 'Sunday chili' }).success).toBe(true)
  })
})
