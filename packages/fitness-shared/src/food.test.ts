import { describe, expect, it } from 'vitest'
import {
  FOOD_SCAN_CONTEXT_MAX,
  buildScanContext,
  createFoodLogEntrySchema,
  foodLabelScanSchema,
  foodScanSchema,
  foodScanResultSchema,
  foldQuotes,
  foodDayTotalsFromSummary,
  isPlausiblePer100g,
  mergeFoodSearchResults,
  foodSearchMemoFresh,
  normalizeFoodSearchQuery,
  normalizeNutritionLabel,
  readNutritionLabel,
  normalizeFdcProduct,
  normalizeOffProduct,
  normalizeOffSearchHits,
  normalizeOffSearchPage,
  nutritionLabelResultSchema,
  patchFoodLogEntrySchema,
  scaleMacros,
  aggregateFoodScanResult,
  applyReferenceWeight,
  formatScannedComponent,
  scannedFoodItemSchema,
  sumFoodDay,
  sumScannedItems,
  upcSchema,
  type FoodItemDto,
  computePortionBias,
  foodGramsCorrected,
} from './food.js'

const offPayload = (nutriments: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  code: '737628064502',
  product: {
    code: '737628064502',
    product_name: 'Rice Noodles',
    brands: 'Thai Kitchen, McCormick',
    serving_size: '45 g',
    nutriments,
    ...extra,
  },
  status: 1,
})

describe('normalizeOffProduct', () => {
  it('normalizes a full v2 payload', () => {
    const out = normalizeOffProduct(
      offPayload({
        'energy-kcal_100g': 360,
        proteins_100g: 7.1,
        carbohydrates_100g: 80,
        fat_100g: 1.2,
      }),
    )
    expect(out).toEqual({
      upc: '737628064502',
      name: 'Rice Noodles',
      brand: 'Thai Kitchen',
      servingGrams: 45,
      servingQuantity: 45,
      servingUnit: 'g',
      isLiquid: false,
      per100g: { kcal: 360, proteinG: 7.1, carbsG: 80, fatG: 1.2 },
    })
  })

  it('accepts brands as an array (Search-a-licious hit shape)', () => {
    const macros = { 'energy-kcal_100g': 360, proteins_100g: 7.1 }
    expect(normalizeOffProduct(offPayload(macros, { brands: ['Quest', 'Other'] }))?.brand).toBe(
      'Quest',
    )
    expect(normalizeOffProduct(offPayload(macros, { brands: ['', ' Jif '] }))?.brand).toBe('Jif')
    expect(normalizeOffProduct(offPayload(macros, { brands: [] }))?.brand).toBeNull()
    expect(normalizeOffProduct(offPayload(macros, { brands: [42] }))?.brand).toBeNull()
  })

  it('derives kcal from kJ when energy-kcal is absent', () => {
    const out = normalizeOffProduct(offPayload({ energy_100g: 1506, proteins_100g: 7 }))
    expect(out?.per100g.kcal).toBe(360)
    expect(out?.per100g.carbsG).toBe(0)
  })

  it('coerces string-typed nutriment values', () => {
    const out = normalizeOffProduct(offPayload({ 'energy-kcal_100g': '360', proteins_100g: '7.1' }))
    expect(out?.per100g).toEqual({ kcal: 360, proteinG: 7.1, carbsG: 0, fatG: 0 })
  })

  it('rejects payloads with no kcal', () => {
    expect(normalizeOffProduct(offPayload({ proteins_100g: 7 }))).toBeNull()
  })

  it('rejects payloads with kcal but no macros at all', () => {
    expect(normalizeOffProduct(offPayload({ 'energy-kcal_100g': 360 }))).toBeNull()
  })

  it('rejects negative / non-numeric values', () => {
    expect(normalizeOffProduct(offPayload({ 'energy-kcal_100g': -5, proteins_100g: 7 }))).toBeNull()
    const out = normalizeOffProduct(
      offPayload({ 'energy-kcal_100g': 100, proteins_100g: 'lots', fat_100g: 1 }),
    )
    expect(out?.per100g.proteinG).toBe(0)
  })

  it('rejects missing name, missing nutriments, and garbage payloads', () => {
    expect(normalizeOffProduct(null)).toBeNull()
    expect(normalizeOffProduct('nope')).toBeNull()
    expect(normalizeOffProduct({})).toBeNull()
    expect(
      normalizeOffProduct(
        offPayload({ 'energy-kcal_100g': 100, fat_100g: 1 }, { product_name: '  ' }),
      ),
    ).toBeNull()
  })

  it('ignores unparseable serving sizes', () => {
    const out = normalizeOffProduct(
      offPayload({ 'energy-kcal_100g': 100, fat_100g: 1 }, { serving_size: '2 x 30 g' }),
    )
    expect(out?.servingGrams).toBeNull()
    expect(out?.servingUnit).toBeNull()
    expect(out?.isLiquid).toBe(false)
  })

  const nutriments = { 'energy-kcal_100g': 64, proteins_100g: 3.4, carbsG_100g: 0, fat_100g: 1.5 }

  it('prefers the structured serving pair and coerces string quantities', () => {
    const out = normalizeOffProduct(
      offPayload(nutriments, {
        serving_size: '2 x 30 g', // unparseable text — structured pair must win
        serving_quantity: '240',
        serving_quantity_unit: 'ml',
      }),
    )
    expect(out?.servingQuantity).toBe(240)
    expect(out?.servingUnit).toBe('ml')
    expect(out?.servingGrams).toBe(240) // ml at 1 g/ml
    expect(out?.isLiquid).toBe(true)
  })

  it('falls back to the serving_size text when the structured unit is not g/ml', () => {
    const out = normalizeOffProduct(
      offPayload(nutriments, {
        serving_size: '30 g',
        serving_quantity: 1,
        serving_quantity_unit: 'oz',
      }),
    )
    expect(out?.servingQuantity).toBe(30)
    expect(out?.servingUnit).toBe('g')
    expect(out?.isLiquid).toBe(false)
  })

  it('parses ml from the serving_size text', () => {
    const out = normalizeOffProduct(offPayload(nutriments, { serving_size: '240 ml' }))
    expect(out?.servingQuantity).toBe(240)
    expect(out?.servingUnit).toBe('ml')
    expect(out?.isLiquid).toBe(true)
  })

  it('marks a product liquid from product_quantity_unit alone (no serving)', () => {
    const out = normalizeOffProduct(
      offPayload(nutriments, { serving_size: undefined, product_quantity_unit: 'ml' }),
    )
    expect(out?.servingQuantity).toBeNull()
    expect(out?.servingGrams).toBeNull()
    expect(out?.isLiquid).toBe(true)
  })

  it('rejects a zero/negative structured serving quantity', () => {
    const out = normalizeOffProduct(
      offPayload(nutriments, {
        serving_size: undefined,
        serving_quantity: 0,
        serving_quantity_unit: 'g',
      }),
    )
    expect(out?.servingQuantity).toBeNull()
  })
})

describe('normalizeFdcProduct', () => {
  const fdcFood = (over: Record<string, unknown> = {}) => ({
    dataType: 'Branded',
    gtinUpc: '00016000275287',
    description: 'Cheerios',
    brandName: 'General Mills',
    brandOwner: 'General Mills Inc',
    servingSize: 39,
    servingSizeUnit: 'g',
    foodNutrients: [
      { nutrientNumber: '208', value: 367 },
      { nutrientNumber: '203', value: 12.4 },
      { nutrientNumber: '205', value: 74 },
      { nutrientNumber: '204', value: 6.5 },
    ],
    ...over,
  })

  it('normalizes a matching Branded hit and keeps the queried UPC', () => {
    const out = normalizeFdcProduct({ foods: [fdcFood()] }, '016000275287')
    expect(out).toEqual({
      upc: '016000275287',
      name: 'Cheerios',
      brand: 'General Mills',
      servingGrams: 39,
      servingQuantity: 39,
      servingUnit: 'g',
      isLiquid: false,
      per100g: { kcal: 367, proteinG: 12.4, carbsG: 74, fatG: 6.5 },
    })
  })

  it('matches gtinUpc zero-padding-insensitively, in both directions', () => {
    expect(normalizeFdcProduct({ foods: [fdcFood()] }, '0000016000275287')?.name).toBe('Cheerios')
    expect(
      normalizeFdcProduct({ foods: [fdcFood({ gtinUpc: '16000275287' })] }, '00016000275287')?.name,
    ).toBe('Cheerios')
  })

  it('skips non-Branded and non-matching hits', () => {
    expect(
      normalizeFdcProduct(
        { foods: [fdcFood({ dataType: 'Survey (FNDDS)' }), fdcFood({ gtinUpc: '999' })] },
        '016000275287',
      ),
    ).toBeNull()
  })

  it('falls back to brandOwner and handles UNECE unit codes + ml liquids', () => {
    const out = normalizeFdcProduct(
      { foods: [fdcFood({ brandName: '', servingSize: 240, servingSizeUnit: 'MLT' })] },
      '016000275287',
    )
    expect(out?.brand).toBe('General Mills Inc')
    expect(out?.servingUnit).toBe('ml')
    expect(out?.isLiquid).toBe(true)
  })

  it('unusable serving unit → null serving, product still returned', () => {
    const out = normalizeFdcProduct(
      { foods: [fdcFood({ servingSizeUnit: 'oz' })] },
      '016000275287',
    )
    expect(out?.servingGrams).toBeNull()
    expect(out?.servingUnit).toBeNull()
  })

  it('rejects hits with no usable macros and malformed payloads', () => {
    expect(
      normalizeFdcProduct({ foods: [fdcFood({ foodNutrients: [] })] }, '016000275287'),
    ).toBeNull()
    expect(
      normalizeFdcProduct(
        { foods: [fdcFood({ foodNutrients: [{ nutrientNumber: '208', value: 367 }] })] },
        '016000275287',
      ),
    ).toBeNull()
    expect(normalizeFdcProduct(null, '1')).toBeNull()
    expect(normalizeFdcProduct({}, '1')).toBeNull()
    expect(normalizeFdcProduct({ foods: [] }, '1')).toBeNull()
  })

  it('accepts numeric nutrientNumber fields (FDC emits both)', () => {
    const out = normalizeFdcProduct(
      {
        foods: [
          fdcFood({
            foodNutrients: [
              { nutrientNumber: 208, value: 100 },
              { nutrientNumber: 203, value: 5 },
            ],
          }),
        ],
      },
      '016000275287',
    )
    expect(out?.per100g).toEqual({ kcal: 100, proteinG: 5, carbsG: 0, fatG: 0 })
  })
})

describe('scaleMacros', () => {
  const per100 = { kcal: 250, proteinG: 26, carbsG: 0.5, fatG: 15 }

  it('scales linearly and rounds (kcal whole, macros 1dp)', () => {
    expect(scaleMacros(per100, 300)).toEqual({ kcal: 750, proteinG: 78, carbsG: 1.5, fatG: 45 })
    expect(scaleMacros(per100, 33)).toEqual({ kcal: 83, proteinG: 8.6, carbsG: 0.2, fatG: 5 })
  })

  it('handles zero grams', () => {
    expect(scaleMacros(per100, 0)).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 })
  })
})

describe('sumFoodDay', () => {
  it('sums and rounds entry macros', () => {
    const totals = sumFoodDay([
      { kcal: 750, proteinG: 78, carbsG: 1.5, fatG: 45 },
      { kcal: 83.4, proteinG: 8.55, carbsG: 0.15, fatG: 5.05 },
    ])
    expect(totals).toEqual({ kcal: 833, proteinG: 86.6, carbsG: 1.7, fatG: 50.1, count: 2 })
  })

  it('handles an empty day', () => {
    expect(sumFoodDay([])).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, count: 0 })
  })
})

describe('foodDayTotalsFromSummary', () => {
  it('rounds a summary row exactly like sumFoodDay rounds the entries', () => {
    const entries = [
      { kcal: 750, proteinG: 78, carbsG: 1.5, fatG: 45 },
      { kcal: 83.4, proteinG: 8.55, carbsG: 0.15, fatG: 5.05 },
    ]
    // The server sums the same rows before rounding, so an unrounded
    // summary row must land on the same displayed numbers the diary shows.
    const raw = entries.reduce(
      (a, e) => ({
        kcal: a.kcal + e.kcal,
        proteinG: a.proteinG + e.proteinG,
        carbsG: a.carbsG + e.carbsG,
        fatG: a.fatG + e.fatG,
      }),
      { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
    )
    expect(foodDayTotalsFromSummary({ date: '2026-07-27', ...raw, entries: 2 })).toEqual(
      sumFoodDay(entries),
    )
  })

  it('treats an absent day as an empty one', () => {
    const empty = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, count: 0 }
    expect(foodDayTotalsFromSummary(null)).toEqual(empty)
    expect(foodDayTotalsFromSummary(undefined)).toEqual(empty)
  })

  it('carries the entry count through', () => {
    const totals = foodDayTotalsFromSummary({
      date: '2026-07-27',
      kcal: 1240,
      proteinG: 82,
      carbsG: 140,
      fatG: 41,
      entries: 5,
    })
    expect(totals).toEqual({ kcal: 1240, proteinG: 82, carbsG: 140, fatG: 41, count: 5 })
  })
})

describe('sumScannedItems', () => {
  it('sums a multi-item scan into one whole-plate entry', () => {
    const combined = sumScannedItems([
      { name: 'Grilled Chicken', estimatedGrams: 150, kcal: 213, proteinG: 35, carbsG: 0, fatG: 9 },
      { name: 'Cauliflower Rice', estimatedGrams: 100, kcal: 30, proteinG: 2, carbsG: 6, fatG: 0 },
      { name: 'Black Beans', estimatedGrams: 50, kcal: 114, proteinG: 8, carbsG: 21, fatG: 1 },
    ])
    expect(combined).toEqual({
      name: 'Whole plate',
      count: null,
      unit: null,
      estimatedGrams: 300,
      kcal: 357,
      proteinG: 45,
      carbsG: 27,
      fatG: 10,
    })
  })

  it('rounds grams/kcal to integers and macros to one decimal', () => {
    const combined = sumScannedItems([
      { name: 'A', estimatedGrams: 33.4, kcal: 83.4, proteinG: 8.55, carbsG: 0.15, fatG: 5.05 },
      { name: 'B', estimatedGrams: 33.4, kcal: 83.4, proteinG: 8.55, carbsG: 0.15, fatG: 5.05 },
    ])
    expect(combined).toEqual({
      name: 'Whole plate',
      count: null,
      unit: null,
      estimatedGrams: 67,
      kcal: 167,
      proteinG: 17.1,
      carbsG: 0.3,
      fatG: 10.1,
    })
  })

  it('passes a single item through (renamed only)', () => {
    const item = { name: 'Corn', estimatedGrams: 50, kcal: 66, proteinG: 2, carbsG: 15, fatG: 1 }
    expect(sumScannedItems([item], 'Corn bowl')).toEqual({
      ...item,
      name: 'Corn bowl',
      count: null,
      unit: null,
    })
  })

  it('clamps sums to the log-entry schema ceilings', () => {
    // 20 items at the scanned-item maxes overflow the per-entry log
    // limits; the combined entry must still pass createFoodLogEntrySchema.
    const max = {
      name: 'X',
      estimatedGrams: 5000,
      kcal: 20000,
      proteinG: 2000,
      carbsG: 2000,
      fatG: 2000,
    }
    const combined = sumScannedItems(Array.from({ length: 20 }, () => max))
    expect(combined).toEqual({
      name: 'Whole plate',
      count: null,
      unit: null,
      estimatedGrams: 20000,
      kcal: 20000,
      proteinG: 2000,
      carbsG: 2000,
      fatG: 2000,
    })
    const logged = createFoodLogEntrySchema.safeParse({
      loggedAt: '2026-07-13T12:00:00.000Z',
      name: combined.name,
      quantityGrams: combined.estimatedGrams,
      kcal: combined.kcal,
      proteinG: combined.proteinG,
      carbsG: combined.carbsG,
      fatG: combined.fatG,
      source: 'photo' as const,
    })
    expect(logged.success).toBe(true)
  })
})

describe('aggregateFoodScanResult', () => {
  it('combines components and derives grams per serving', () => {
    const meal = aggregateFoodScanResult({
      mealName: 'Chicken rice bowl',
      estimatedServings: 1.5,
      items: [
        { name: 'Chicken', estimatedGrams: 150, kcal: 250, proteinG: 40, carbsG: 0, fatG: 8 },
        { name: 'Rice', estimatedGrams: 150, kcal: 195, proteinG: 4, carbsG: 42, fatG: 0.5 },
      ],
      questions: [],
    })
    expect(meal).toMatchObject({
      name: 'Chicken rice bowl',
      estimatedServings: 1.5,
      estimatedGrams: 300,
      servingGrams: 200,
      kcal: 445,
    })
    expect(meal?.components).toHaveLength(2)
  })

  it('returns null for a no-food result', () => {
    expect(
      aggregateFoodScanResult({
        mealName: null,
        estimatedServings: null,
        items: [],
        questions: [],
      }),
    ).toBeNull()
  })

  it('carries count/unit through to components for countable items', () => {
    const meal = aggregateFoodScanResult({
      mealName: 'Eggs and toast',
      estimatedServings: 1,
      items: [
        { name: 'Fried egg', count: 2, unit: 'egg', estimatedGrams: 103, kcal: 143, proteinG: 12, carbsG: 1, fatG: 10 },
        { name: 'Toast', count: 2, unit: 'slice', estimatedGrams: 58, kcal: 150, proteinG: 5, carbsG: 28, fatG: 2 },
      ],
      questions: [],
    })
    expect(meal?.components[0]).toMatchObject({ count: 2, unit: 'egg' })
    // The whole-plate aggregate itself is never a single countable item.
    expect(meal).toMatchObject({ count: null, unit: null })
  })

  it('grounds countable items on reference weights before summing', () => {
    // Model reports a lazy round 100 g for 2 eggs; grounding corrects it to
    // 2 × 55 = 110 g and scales the macros + the whole-plate total to match.
    const meal = aggregateFoodScanResult({
      mealName: 'Two eggs',
      estimatedServings: 1,
      items: [
        { name: 'Fried egg', count: 2, unit: 'egg', estimatedGrams: 100, kcal: 140, proteinG: 12, carbsG: 2, fatG: 10 },
      ],
      questions: [],
    })
    // 2 eggs → 110 g; macros scaled by 110/100 = 1.1.
    expect(meal?.components[0]).toMatchObject({
      count: 2,
      unit: 'egg',
      estimatedGrams: 110,
      kcal: 154,
      proteinG: 13.2,
      fatG: 11,
    })
    // The whole-plate total reflects the grounded grams, not the raw 100 g.
    expect(meal?.estimatedGrams).toBe(110)
    expect(meal?.kcal).toBe(154)
    expect(meal?.servingGrams).toBe(110)
  })

  it('leaves amorphous and unrecognised-unit items on the model estimate', () => {
    const meal = aggregateFoodScanResult({
      mealName: 'Rice and toast',
      estimatedServings: 1,
      items: [
        { name: 'Rice', estimatedGrams: 150, kcal: 195, proteinG: 4, carbsG: 42, fatG: 0.5 },
        // "slice" is deliberately excluded from the reference table.
        { name: 'Toast', count: 2, unit: 'slice', estimatedGrams: 58, kcal: 150, proteinG: 5, carbsG: 28, fatG: 2 },
      ],
      questions: [],
    })
    expect(meal?.components[0]?.estimatedGrams).toBe(150)
    expect(meal?.components[1]?.estimatedGrams).toBe(58)
    expect(meal?.estimatedGrams).toBe(208)
  })
})

describe('applyReferenceWeight', () => {
  const egg = {
    name: 'Fried egg',
    count: 2,
    unit: 'egg',
    estimatedGrams: 100,
    kcal: 140,
    proteinG: 12,
    carbsG: 2,
    fatG: 10,
  }

  it('derives grams from count × per-unit average and scales macros', () => {
    expect(applyReferenceWeight(egg)).toEqual({
      ...egg,
      estimatedGrams: 110,
      kcal: 154,
      proteinG: 13.2,
      carbsG: 2.2,
      fatG: 11,
    })
  })

  it('matches the singular unit even when the model returns a plural', () => {
    expect(applyReferenceWeight({ ...egg, unit: 'eggs' }).estimatedGrams).toBe(110)
  })

  it('normalises unit case and surrounding whitespace', () => {
    expect(applyReferenceWeight({ ...egg, unit: '  Egg ' }).estimatedGrams).toBe(110)
  })

  it('leaves the item untouched when the unit is not in the table', () => {
    const slice = { ...egg, name: 'Toast', unit: 'slice', estimatedGrams: 58 }
    expect(applyReferenceWeight(slice)).toEqual(slice)
  })

  it('leaves amorphous items (no count/unit) untouched', () => {
    const rice = {
      name: 'Rice',
      count: null,
      unit: null,
      estimatedGrams: 150,
      kcal: 195,
      proteinG: 4,
      carbsG: 42,
      fatG: 0.5,
    }
    expect(applyReferenceWeight(rice)).toEqual(rice)
  })

  it('ignores an out-of-range count', () => {
    const zero = { ...egg, count: 0 }
    const huge = { ...egg, count: 1000 }
    expect(applyReferenceWeight(zero)).toEqual(zero)
    expect(applyReferenceWeight(huge)).toEqual(huge)
  })

  it('rounds a fractional count to a whole number of units', () => {
    // 3 strips × 10 g = 30 g.
    const bacon = { ...egg, name: 'Bacon', unit: 'strip', count: 2.6, estimatedGrams: 40 }
    expect(applyReferenceWeight(bacon).estimatedGrams).toBe(30)
  })

  it('clamps a reference weight to the 5000 g schema ceiling', () => {
    const meatballs = { ...egg, name: 'Meatballs', unit: 'meatball', count: 999, estimatedGrams: 200 }
    expect(applyReferenceWeight(meatballs).estimatedGrams).toBe(5000)
  })

  it('adjusts grams but not macros when the target equals the rounded estimate', () => {
    // 1 pancake × 40 g and the model already said 40 g → no macro rescale.
    const pancake = { ...egg, name: 'Pancake', unit: 'pancake', count: 1, estimatedGrams: 40 }
    const out = applyReferenceWeight(pancake)
    expect(out.estimatedGrams).toBe(40)
    expect(out.kcal).toBe(pancake.kcal)
  })
})

describe('scannedFoodItemSchema', () => {
  it('allows omitting count/unit for amorphous foods', () => {
    const parsed = scannedFoodItemSchema.parse({
      name: 'Rice',
      estimatedGrams: 137,
      kcal: 178,
      proteinG: 3,
      carbsG: 39,
      fatG: 0.4,
    })
    expect(parsed.count).toBeUndefined()
    expect(parsed.unit).toBeUndefined()
    // A non-countable item renders as name · grams either way.
    expect(formatScannedComponent(parsed)).toBe('Rice · 137 g')
  })

  it('accepts an explicit count/unit pair', () => {
    const parsed = scannedFoodItemSchema.parse({
      name: 'Egg',
      count: 3,
      unit: 'egg',
      estimatedGrams: 156,
      kcal: 216,
      proteinG: 19,
      carbsG: 1,
      fatG: 15,
    })
    expect(parsed).toMatchObject({ count: 3, unit: 'egg' })
  })

  it('accepts any finite count / string unit so an odd value never fails the item', () => {
    // guided_json only constrains type, not range — the model can still
    // emit count 0 or a huge count for a countable item. The schema stays
    // permissive (sanity lives in formatScannedComponent), so parsing must
    // succeed and just pass the value through.
    const base = {
      name: 'Grapes',
      estimatedGrams: 120,
      kcal: 80,
      proteinG: 1,
      carbsG: 20,
      fatG: 0,
    }
    expect(scannedFoodItemSchema.parse({ ...base, count: 0, unit: 'grape' }).count).toBe(0)
    expect(scannedFoodItemSchema.parse({ ...base, count: 5000, unit: 'grape' }).count).toBe(5000)
  })

  it('keeps a whole scan valid when one item has an out-of-range count', () => {
    const result = foodScanResultSchema.safeParse({
      mealName: 'Fruit bowl',
      estimatedServings: 1,
      items: [
        { name: 'Grapes', count: 0, unit: 'grape', estimatedGrams: 120, kcal: 80, proteinG: 1, carbsG: 20, fatG: 0 },
      ],
      questions: [],
    })
    expect(result.success).toBe(true)
  })
})

describe('formatScannedComponent', () => {
  const base = { name: 'X', estimatedGrams: 103, kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }

  it('renders a pluralized count for countable items', () => {
    expect(formatScannedComponent({ ...base, count: 2, unit: 'egg' })).toBe('2 eggs · 103 g')
  })

  it('keeps the singular unit for a count of one', () => {
    expect(formatScannedComponent({ ...base, count: 1, unit: 'slice', estimatedGrams: 30 })).toBe(
      '1 slice · 30 g',
    )
  })

  it('rounds a stray decimal count for display rather than failing', () => {
    expect(formatScannedComponent({ ...base, count: 2.4, unit: 'egg' })).toBe('2 eggs · 103 g')
  })

  it('pluralizes irregular food nouns grammatically', () => {
    expect(formatScannedComponent({ ...base, count: 3, unit: 'peach' })).toBe('3 peaches · 103 g')
    expect(formatScannedComponent({ ...base, count: 6, unit: 'berry' })).toBe('6 berries · 103 g')
    expect(formatScannedComponent({ ...base, count: 2, unit: 'tomato' })).toBe('2 tomatoes · 103 g')
    expect(formatScannedComponent({ ...base, count: 4, unit: 'cookie' })).toBe('4 cookies · 103 g')
    // -o loanwords take a plain +s, not +es.
    expect(formatScannedComponent({ ...base, count: 2, unit: 'taco' })).toBe('2 tacos · 103 g')
    expect(formatScannedComponent({ ...base, count: 3, unit: 'burrito' })).toBe('3 burritos · 103 g')
  })

  it('falls back to name · grams when count or unit is absent', () => {
    expect(formatScannedComponent({ ...base, name: 'Rice', count: null, unit: null })).toBe(
      'Rice · 103 g',
    )
    expect(formatScannedComponent({ ...base, name: 'Rice', count: 2, unit: null })).toBe(
      'Rice · 103 g',
    )
  })

  it('falls back for an out-of-range or blank count/unit the schema let through', () => {
    expect(formatScannedComponent({ ...base, name: 'Grapes', count: 0, unit: 'grape' })).toBe(
      'Grapes · 103 g',
    )
    expect(formatScannedComponent({ ...base, name: 'Grapes', count: 5000, unit: 'grape' })).toBe(
      'Grapes · 103 g',
    )
    expect(formatScannedComponent({ ...base, name: 'Rice', count: 2, unit: '   ' })).toBe(
      'Rice · 103 g',
    )
  })
})

describe('buildScanContext', () => {
  it('renders base, Q/A pairs, and correction lines in order', () => {
    const out = buildScanContext({
      base: 'total weight 300g',
      answers: [{ question: 'White or brown rice?', answer: 'brown' }],
      corrections: ['there are no beans in here'],
    })
    expect(out).toBe(
      'total weight 300g\nWhite or brown rice? → brown\nCorrection: there are no beans in here',
    )
  })

  it('drops blank parts entirely', () => {
    expect(buildScanContext({})).toBe('')
    expect(
      buildScanContext({
        base: '  ',
        answers: [
          { question: 'Q?', answer: '   ' },
          { question: '', answer: 'x' },
        ],
        corrections: ['', '  '],
      }),
    ).toBe('')
  })

  it('works with only corrections', () => {
    expect(buildScanContext({ corrections: ['no beans', 'that is chicken not pork'] })).toBe(
      'Correction: no beans\nCorrection: that is chicken not pork',
    )
  })

  it('never exceeds FOOD_SCAN_CONTEXT_MAX and sheds oldest answers first', () => {
    const long = 'x'.repeat(1200)
    const out = buildScanContext({
      base: 'keep me',
      answers: [
        { question: 'old?', answer: long },
        { question: 'new?', answer: long },
      ],
      corrections: ['the newest correction'],
    })
    expect(out.length).toBeLessThanOrEqual(FOOD_SCAN_CONTEXT_MAX)
    expect(out).toContain('keep me')
    expect(out).not.toContain('old?')
    expect(out).toContain('Correction: the newest correction')
  })

  it('keeps the newest correction when shedding corrections', () => {
    const long = 'y'.repeat(2100)
    const out = buildScanContext({
      corrections: [long, 'newest'],
    })
    expect(out.length).toBeLessThanOrEqual(FOOD_SCAN_CONTEXT_MAX)
    expect(out).toContain('Correction: newest')
    expect(out).not.toContain(long)
  })

  it('hard-truncates a single oversized part as a last resort', () => {
    const out = buildScanContext({ base: 'z'.repeat(3000) })
    expect(out.length).toBe(FOOD_SCAN_CONTEXT_MAX)
  })

  it('always satisfies foodScanSchema.context', () => {
    const out = buildScanContext({
      base: 'b'.repeat(1999),
      answers: [{ question: 'q'.repeat(500), answer: 'a'.repeat(500) }],
      corrections: ['c'.repeat(500)],
    })
    expect(out.length).toBeLessThanOrEqual(FOOD_SCAN_CONTEXT_MAX)
  })
})

describe('normalizeFoodSearchQuery', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeFoodSearchQuery('  peanut   butter  ')).toBe('peanut butter')
  })

  it('returns empty for blank or too-short queries', () => {
    expect(normalizeFoodSearchQuery('')).toBe('')
    expect(normalizeFoodSearchQuery('  ')).toBe('')
    expect(normalizeFoodSearchQuery('a')).toBe('')
    expect(normalizeFoodSearchQuery(123 as unknown)).toBe('')
  })

  it('keeps a valid two-char query', () => {
    expect(normalizeFoodSearchQuery('pb')).toBe('pb')
  })

  it('folds iOS smart apostrophes and quotes to ASCII', () => {
    // iOS types a curly ’ (U+2019); the cache mostly stores straight '.
    expect(normalizeFoodSearchQuery('Trader Joe’s abc bar')).toBe("Trader Joe's abc bar")
    expect(normalizeFoodSearchQuery('Reese‘s')).toBe("Reese's")
    expect(normalizeFoodSearchQuery('“quoted”')).toBe('"quoted"')
  })
})

describe('foldQuotes', () => {
  it('folds every apostrophe variant to ASCII apostrophe', () => {
    // U+2019 ’, U+2018 ‘, U+02BC ʼ, U+2032 ′, U+00B4 ´, U+0060 `
    for (const v of ['’', '‘', 'ʼ', '′', '´', '`']) {
      expect(foldQuotes(`Joe${v}s`)).toBe("Joe's")
    }
  })

  it('folds every double-quote variant to ASCII quote', () => {
    // U+201C “, U+201D ”, U+201E „
    for (const v of ['“', '”', '„']) {
      expect(foldQuotes(`${v}x`)).toBe('"x')
    }
  })

  it('leaves ASCII quotes and unrelated characters untouched', () => {
    expect(foldQuotes("Joe's 12\" bar-b-q")).toBe("Joe's 12\" bar-b-q")
    expect(foldQuotes('')).toBe('')
  })
})

describe('normalizeOffSearchPage', () => {
  const product = (code: string, name: string) => ({
    code,
    product_name: name,
    brands: 'Acme',
    nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 10, fat_100g: 2 },
  })

  it('normalizes usable products and drops unusable rows', () => {
    const out = normalizeOffSearchPage({
      products: [
        product('111', 'Alpha'),
        { code: '222', product_name: 'No nutriments' }, // dropped (no per-100g)
        product('333', 'Gamma'),
      ],
    })
    expect(out.map((p) => p.upc)).toEqual(['111', '333'])
  })

  it('dedupes repeated UPCs, keeping the first', () => {
    const out = normalizeOffSearchPage({
      products: [product('111', 'First'), product('111', 'Second')],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('First')
  })

  it('returns [] for a non-object or missing products array', () => {
    expect(normalizeOffSearchPage(null)).toEqual([])
    expect(normalizeOffSearchPage({})).toEqual([])
    expect(normalizeOffSearchPage({ products: 'nope' })).toEqual([])
  })
})

describe('normalizeOffSearchHits', () => {
  const hit = (code: string, name: string) => ({
    code,
    product_name: name,
    brands: 'Acme',
    nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 10, fat_100g: 2 },
  })

  it('normalizes a Search-a-licious hits page with the same pruning/dedupe', () => {
    const out = normalizeOffSearchHits({
      hits: [
        hit('111', 'Alpha'),
        { code: '222', product_name: 'No nutriments' }, // dropped
        hit('111', 'Dupe'), // deduped
        hit('333', 'Gamma'),
      ],
    })
    expect(out.map((p) => p.upc)).toEqual(['111', '333'])
    expect(out[0]!.name).toBe('Alpha')
  })

  it('returns [] for a non-object or missing hits array', () => {
    expect(normalizeOffSearchHits(null)).toEqual([])
    expect(normalizeOffSearchHits({})).toEqual([])
    expect(normalizeOffSearchHits({ hits: 'nope' })).toEqual([])
    expect(normalizeOffSearchHits({ products: [hit('111', 'Wrong key')] })).toEqual([])
  })
})

describe('foodSearchMemoFresh', () => {
  const now = new Date('2026-07-22T12:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)

  it('is false with no memo', () => {
    expect(foodSearchMemoFresh(null, now)).toBe(false)
  })
  it('memos with results stay fresh for the long TTL', () => {
    expect(foodSearchMemoFresh({ resultCount: 3, fetchedAt: ago(60 * 60 * 1000) }, now)).toBe(true)
    expect(foodSearchMemoFresh({ resultCount: 3, fetchedAt: ago(25 * 60 * 60 * 1000) }, now)).toBe(
      false,
    )
  })
  it('zero-result memos expire on the short TTL so retries are not suppressed for a day', () => {
    expect(foodSearchMemoFresh({ resultCount: 0, fetchedAt: ago(5 * 60 * 1000) }, now)).toBe(true)
    expect(foodSearchMemoFresh({ resultCount: 0, fetchedAt: ago(20 * 60 * 1000) }, now)).toBe(false)
  })
})

describe('mergeFoodSearchResults', () => {
  const dto = (id: string, upc: string | null): FoodItemDto => ({
    id,
    upc,
    source: 'off',
    name: id,
    brand: null,
    servingGrams: null,
    servingQuantity: null,
    servingUnit: null,
    isLiquid: false,
    per100g: { kcal: 100, proteinG: 1, carbsG: 1, fatG: 1 },
  })

  it('lists local first, external after', () => {
    const out = mergeFoodSearchResults([dto('a', '111')], [dto('b', '222')])
    expect(out.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('drops an external row whose UPC already appears locally', () => {
    const out = mergeFoodSearchResults([dto('local', '111')], [dto('external', '111')])
    expect(out.map((i) => i.id)).toEqual(['local'])
  })

  it('dedupes null-UPC rows by id, not by null', () => {
    const out = mergeFoodSearchResults([dto('a', null)], [dto('b', null), dto('a', null)])
    expect(out.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('caps to the limit', () => {
    const out = mergeFoodSearchResults(
      [dto('a', '1'), dto('b', '2')],
      [dto('c', '3'), dto('d', '4')],
      3,
    )
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('normalizeNutritionLabel', () => {
  const label = (over: Record<string, unknown> = {}) => ({
    name: 'Protein Bar',
    brand: 'Acme',
    servingGrams: 50,
    servingUnit: 'g' as const,
    perServing: { kcal: 200, proteinG: 20, carbsG: 22, fatG: 7 },
    ...over,
  })

  it('scales a per-serving read to per-100g', () => {
    const out = normalizeNutritionLabel('737628064502', label())
    expect(out).toEqual({
      upc: '737628064502',
      name: 'Protein Bar',
      brand: 'Acme',
      servingGrams: 50,
      servingQuantity: 50,
      servingUnit: 'g',
      isLiquid: false,
      per100g: { kcal: 400, proteinG: 40, carbsG: 44, fatG: 14 },
    })
  })

  it('marks ml servings liquid (1 ml ≈ 1 g)', () => {
    const out = normalizeNutritionLabel(
      '111',
      label({ servingUnit: 'ml', servingGrams: 240, perServing: { kcal: 120, proteinG: 8, carbsG: 12, fatG: 5 } }),
    )
    expect(out?.isLiquid).toBe(true)
    expect(out?.per100g).toEqual({ kcal: 50, proteinG: 3.3, carbsG: 5, fatG: 2.1 })
  })

  it('returns null on an unusable read', () => {
    expect(normalizeNutritionLabel('111', label({ name: null }))).toBeNull()
    expect(normalizeNutritionLabel('111', label({ name: '   ' }))).toBeNull()
    expect(normalizeNutritionLabel('111', label({ servingGrams: null }))).toBeNull()
    expect(normalizeNutritionLabel('111', label({ servingGrams: 0 }))).toBeNull()
    expect(normalizeNutritionLabel('111', label({ perServing: null }))).toBeNull()
  })

  it('rejects an implausible energy density (misread serving size)', () => {
    // 900 kcal in a 5 g serving → 18000 kcal/100g, impossible.
    const out = normalizeNutritionLabel(
      '111',
      label({ servingGrams: 5, perServing: { kcal: 900, proteinG: 0, carbsG: 0, fatG: 100 } }),
    )
    expect(out).toBeNull()
  })

  it('names the failing gate via readNutritionLabel', () => {
    const reason = (over: Record<string, unknown>) => {
      const read = readNutritionLabel('111', label(over))
      return read.ok ? null : read.reason
    }
    expect(reason({ name: null })).toBe('no_name')
    expect(reason({ name: '   ' })).toBe('no_name')
    expect(reason({ servingGrams: null })).toBe('no_serving')
    expect(reason({ servingGrams: 0 })).toBe('no_serving')
    expect(reason({ perServing: null })).toBe('no_macros')
    expect(
      reason({ servingGrams: 5, perServing: { kcal: 900, proteinG: 0, carbsG: 0, fatG: 100 } }),
    ).toBe('implausible')
    const good = readNutritionLabel('111', label())
    expect(good.ok).toBe(true)
  })

  it('rejects a physically-impossible macro (>100 g per 100 g)', () => {
    // 40 g protein in a 20 g serving → 200 g/100g, impossible, but the
    // low kcal keeps it under the energy ceiling — the macro gate catches it.
    const out = normalizeNutritionLabel(
      '111',
      label({ servingGrams: 20, perServing: { kcal: 80, proteinG: 40, carbsG: 0, fatG: 0 } }),
    )
    expect(out).toBeNull()
  })

  it('drops a blank brand to null', () => {
    const out = normalizeNutritionLabel('111', label({ brand: null }))
    expect(out?.brand).toBeNull()
  })
})

describe('isPlausiblePer100g', () => {
  it('accepts a real product and rejects impossible densities/macros', () => {
    expect(isPlausiblePer100g({ kcal: 400, proteinG: 40, carbsG: 44, fatG: 14 })).toBe(true)
    expect(isPlausiblePer100g({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 })).toBe(true)
    // energy density past pure fat
    expect(isPlausiblePer100g({ kcal: 20000, proteinG: 0, carbsG: 0, fatG: 0 })).toBe(false)
    // a single macro over 100 g per 100 g
    expect(isPlausiblePer100g({ kcal: 100, proteinG: 200, carbsG: 0, fatG: 0 })).toBe(false)
    // negative / non-finite
    expect(isPlausiblePer100g({ kcal: -1, proteinG: 0, carbsG: 0, fatG: 0 })).toBe(false)
    expect(isPlausiblePer100g({ kcal: Infinity, proteinG: 0, carbsG: 0, fatG: 0 })).toBe(false)
  })
})

describe('nutritionLabelResultSchema', () => {
  const ok = {
    name: 'Cereal',
    brand: 'Acme',
    servingGrams: 40,
    servingUnit: 'g',
    perServing: { kcal: 150, proteinG: 3, carbsG: 30, fatG: 2 },
  }

  it('accepts a full read and an all-null read', () => {
    expect(nutritionLabelResultSchema.safeParse(ok).success).toBe(true)
    expect(
      nutritionLabelResultSchema.safeParse({
        name: null,
        brand: null,
        servingGrams: null,
        servingUnit: null,
        perServing: null,
      }).success,
    ).toBe(true)
  })

  it('rejects a bad serving unit or negative macro', () => {
    expect(nutritionLabelResultSchema.safeParse({ ...ok, servingUnit: 'oz' }).success).toBe(false)
    expect(
      nutritionLabelResultSchema.safeParse({
        ...ok,
        perServing: { kcal: -1, proteinG: 3, carbsG: 30, fatG: 2 },
      }).success,
    ).toBe(false)
  })
})

describe('validators', () => {
  it('upcSchema accepts UPC-A/EAN-13 and rejects junk', () => {
    expect(upcSchema.safeParse('737628064502').success).toBe(true)
    expect(upcSchema.safeParse(' 12345678 ').success).toBe(true)
    expect(upcSchema.safeParse('1234567').success).toBe(false)
    expect(upcSchema.safeParse('12345678901234567').success).toBe(false)
    expect(upcSchema.safeParse('abc123').success).toBe(false)
  })

  it('createFoodLogEntrySchema enforces bounds', () => {
    const base = {
      loggedAt: '2026-07-13T12:00:00.000Z',
      name: 'Chicken breast',
      quantityGrams: 300,
      kcal: 495,
      proteinG: 93,
      carbsG: 0,
      fatG: 10.8,
      source: 'barcode' as const,
    }
    expect(createFoodLogEntrySchema.safeParse(base).success).toBe(true)
    expect(createFoodLogEntrySchema.safeParse({ ...base, kcal: -1 }).success).toBe(false)
    expect(createFoodLogEntrySchema.safeParse({ ...base, source: 'psychic' }).success).toBe(false)
    expect(createFoodLogEntrySchema.safeParse({ ...base, name: ' ' }).success).toBe(false)
  })

  it('createFoodLogEntrySchema pairs quantityUnit with quantityAmount and grams', () => {
    const base = {
      loggedAt: '2026-07-13T12:00:00.000Z',
      name: 'Milk',
      quantityGrams: 236.6,
      kcal: 149,
      proteinG: 8,
      carbsG: 12,
      fatG: 8,
      source: 'barcode' as const,
    }
    const withPair = { ...base, quantityUnit: 'cup', quantityAmount: 1 }
    expect(createFoodLogEntrySchema.safeParse(withPair).success).toBe(true)
    expect(createFoodLogEntrySchema.safeParse({ ...base, quantityUnit: 'cup' }).success).toBe(false)
    expect(createFoodLogEntrySchema.safeParse({ ...base, quantityAmount: 1 }).success).toBe(false)
    expect(
      createFoodLogEntrySchema.safeParse({
        ...withPair,
        quantityGrams: undefined,
      }).success,
    ).toBe(false)
    expect(createFoodLogEntrySchema.safeParse({ ...withPair, quantityUnit: 'stone' }).success).toBe(
      false,
    )
  })

  it('restricts saveAsCustom to positive-gram, unreferenced manual entries', () => {
    const base = {
      loggedAt: '2026-07-13T12:00:00.000Z',
      name: 'Home oats',
      quantityGrams: 80,
      kcal: 300,
      proteinG: 10,
      carbsG: 50,
      fatG: 7,
      source: 'manual' as const,
      saveAsCustom: true,
    }
    expect(createFoodLogEntrySchema.safeParse(base).success).toBe(true)
    expect(createFoodLogEntrySchema.safeParse({ ...base, source: 'photo' }).success).toBe(false)
    expect(createFoodLogEntrySchema.safeParse({ ...base, quantityGrams: undefined }).success).toBe(
      false,
    )
    expect(createFoodLogEntrySchema.safeParse({ ...base, foodItemId: 'ff_existing' }).success).toBe(
      false,
    )
  })

  it('restricts saveAsUpc to positive-gram, unreferenced barcode entries', () => {
    const base = {
      loggedAt: '2026-07-13T12:00:00.000Z',
      name: 'Store brand granola',
      quantityGrams: 55,
      kcal: 240,
      proteinG: 6,
      carbsG: 34,
      fatG: 9,
      source: 'barcode' as const,
      saveAsUpc: {
        upc: '012345678905',
        token: 'contrib-token',
        brand: 'Store',
        servingGrams: 55,
        servingUnit: 'g' as const,
        isLiquid: false,
      },
    }
    expect(createFoodLogEntrySchema.safeParse(base).success).toBe(true)
    // token is required
    expect(
      createFoodLogEntrySchema.safeParse({
        ...base,
        saveAsUpc: { ...base.saveAsUpc, token: '' },
      }).success,
    ).toBe(false)
    // wrong source
    expect(createFoodLogEntrySchema.safeParse({ ...base, source: 'manual' }).success).toBe(false)
    // referenced item can't also contribute a UPC
    expect(createFoodLogEntrySchema.safeParse({ ...base, foodItemId: 'ff_x' }).success).toBe(false)
    // needs grams to derive per-100g
    expect(
      createFoodLogEntrySchema.safeParse({ ...base, quantityGrams: undefined }).success,
    ).toBe(false)
    // mutually exclusive with saveAsCustom
    expect(
      createFoodLogEntrySchema.safeParse({ ...base, source: 'manual', saveAsCustom: true }).success,
    ).toBe(false)
    // bad upc inside the object
    expect(
      createFoodLogEntrySchema.safeParse({ ...base, saveAsUpc: { ...base.saveAsUpc, upc: 'abc' } })
        .success,
    ).toBe(false)
    // the "Incorrect?" correction flag: only literal true is accepted
    expect(
      createFoodLogEntrySchema.safeParse({
        ...base,
        saveAsUpc: { ...base.saveAsUpc, correction: true },
      }).success,
    ).toBe(true)
    expect(
      createFoodLogEntrySchema.safeParse({
        ...base,
        saveAsUpc: { ...base.saveAsUpc, correction: false },
      }).success,
    ).toBe(false)
  })

  it('foodLabelScanSchema requires a upc + primary image, product photo optional', () => {
    const base = { upc: '012345678905', imageBase64: 'abc', mimeType: 'image/jpeg' }
    expect(foodLabelScanSchema.safeParse(base).success).toBe(true)
    expect(
      foodLabelScanSchema.safeParse({
        ...base,
        productImage: { imageBase64: 'def', mimeType: 'image/png' },
      }).success,
    ).toBe(true)
    expect(foodLabelScanSchema.safeParse({ imageBase64: 'abc', mimeType: 'image/jpeg' }).success).toBe(
      false,
    )
    expect(foodLabelScanSchema.safeParse({ ...base, upc: 'nope' }).success).toBe(false)
    expect(foodLabelScanSchema.safeParse({ ...base, mimeType: 'text/plain' }).success).toBe(false)
  })

  it('patchFoodLogEntrySchema allows clearing the quantity trio together', () => {
    expect(
      patchFoodLogEntrySchema.safeParse({
        quantityGrams: null,
        quantityUnit: null,
        quantityAmount: null,
      }).success,
    ).toBe(true)
    expect(
      patchFoodLogEntrySchema.safeParse({
        quantityGrams: 340,
        quantityUnit: 'oz',
        quantityAmount: 12,
      }).success,
    ).toBe(true)
    // unit set without amount / without grams
    expect(patchFoodLogEntrySchema.safeParse({ quantityUnit: 'oz' }).success).toBe(false)
    expect(
      patchFoodLogEntrySchema.safeParse({ quantityUnit: 'oz', quantityAmount: 12 }).success,
    ).toBe(false)
    // asymmetric clear
    expect(
      patchFoodLogEntrySchema.safeParse({ quantityUnit: null, quantityAmount: 2 }).success,
    ).toBe(false)
  })

  it('foodScanResultSchema validates AI output shape', () => {
    const ok = {
      mealName: 'Beef and rice',
      estimatedServings: 1,
      items: [
        {
          name: 'Lean ground beef',
          estimatedGrams: 300,
          kcal: 750,
          proteinG: 78,
          carbsG: 0,
          fatG: 45,
        },
      ],
      questions: ['Is the rice white or brown?'],
    }
    expect(foodScanResultSchema.safeParse(ok).success).toBe(true)
    expect(foodScanResultSchema.safeParse({ ...ok, mealName: null }).success).toBe(false)
    expect(
      foodScanResultSchema.safeParse({
        mealName: 'Nothing',
        estimatedServings: 1,
        items: [],
        questions: [],
      }).success,
    ).toBe(false)
    expect(
      foodScanResultSchema.safeParse({ items: [{ name: '', estimatedGrams: 0 }], questions: [] })
        .success,
    ).toBe(false)
  })

  it('foodScanSchema accepts a primary-only or two-image request', () => {
    const primary = { imageBase64: 'abc', mimeType: 'image/jpeg' }
    expect(foodScanSchema.safeParse(primary).success).toBe(true)
    expect(
      foodScanSchema.safeParse({
        ...primary,
        supportingImage: { imageBase64: 'def', mimeType: 'image/png' },
      }).success,
    ).toBe(true)
    expect(
      foodScanSchema.safeParse({
        ...primary,
        supportingImage: { imageBase64: '', mimeType: 'text/plain' },
      }).success,
    ).toBe(false)
  })
})

describe('computePortionBias', () => {
  const pairs = (ratios: number[]) =>
    ratios.map((r) => ({ estimatedGrams: 100, actualGrams: 100 * r }))

  it('returns 1.0 with fewer than 3 usable samples', () => {
    expect(computePortionBias([])).toBe(1.0)
    expect(computePortionBias(pairs([1.5, 1.5]))).toBe(1.0)
    // Zero/negative estimates or actuals are unusable and don't count.
    expect(
      computePortionBias([
        { estimatedGrams: 0, actualGrams: 100 },
        { estimatedGrams: 100, actualGrams: 0 },
        ...pairs([1.2, 1.2]),
      ]),
    ).toBe(1.0)
  })

  it('finds the median of a systematic over/under-estimate', () => {
    // User's portions run ~20% heavier than the model guesses.
    expect(computePortionBias(pairs([1.1, 1.2, 1.3]))).toBeCloseTo(1.2)
    // And the under-estimate direction.
    expect(computePortionBias(pairs([0.7, 0.8, 0.9]))).toBeCloseTo(0.8)
    // Even-count history averages the middle pair.
    expect(computePortionBias(pairs([1.0, 1.1, 1.3, 1.4]))).toBeCloseTo(1.2)
  })

  it('is robust to a wild outlier scan', () => {
    expect(computePortionBias(pairs([1.1, 1.2, 1.2, 1.3, 9.0]))).toBeCloseTo(1.2)
  })

  it('clamps to [0.5, 2.0]', () => {
    expect(computePortionBias(pairs([3, 4, 5]))).toBe(2.0)
    expect(computePortionBias(pairs([0.1, 0.2, 0.3]))).toBe(0.5)
  })
})

describe('foodGramsCorrected', () => {
  it('is quiet within max(1 g, 1%) of the calibrated prefill', () => {
    expect(foodGramsCorrected(300, 300)).toBe(false)
    expect(foodGramsCorrected(301, 300)).toBe(false) // 1% of 300 = 3 g
    expect(foodGramsCorrected(303, 300)).toBe(false)
    expect(foodGramsCorrected(50.9, 50)).toBe(false) // 1 g floor beats 0.5 g
  })

  it('flags a real correction', () => {
    expect(foodGramsCorrected(304.1, 300)).toBe(true)
    expect(foodGramsCorrected(180, 150)).toBe(true)
  })

  it('compares against estimate × bias, not the raw estimate', () => {
    // Raw 200 g, bias 1.5 → prefill 300 g. Accepting the prefill is NOT
    // a correction (the anti-self-poisoning case)...
    expect(foodGramsCorrected(300, 200, 1.5)).toBe(false)
    // ...but landing on the raw estimate IS one.
    expect(foodGramsCorrected(200, 200, 1.5)).toBe(true)
  })
})

describe('createFoodLogEntrySchema estimation-tracking fields', () => {
  const base = {
    loggedAt: new Date().toISOString(),
    name: 'Chicken and rice',
    kcal: 600,
    proteinG: 40,
    carbsG: 60,
    fatG: 15,
  }

  it('accepts the fields on a photo entry', () => {
    expect(
      createFoodLogEntrySchema.safeParse({
        ...base,
        source: 'photo',
        quantityGrams: 350,
        estimatedGrams: 320,
        scanResponseId: 'resp_abc',
        portionBias: 1.1,
      }).success,
    ).toBe(true)
  })

  it('rejects the fields on non-photo entries', () => {
    expect(
      createFoodLogEntrySchema.safeParse({
        ...base,
        source: 'manual',
        estimatedGrams: 320,
      }).success,
    ).toBe(false)
    expect(
      createFoodLogEntrySchema.safeParse({
        ...base,
        source: 'barcode',
        scanResponseId: 'resp_abc',
      }).success,
    ).toBe(false)
  })
})
