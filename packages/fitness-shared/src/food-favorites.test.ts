import { describe, expect, it } from 'vitest'
import {
  FOOD_LOG_SOURCES,
  createFoodFavoriteSchema,
  createFoodLogEntrySchema,
  favoriteToLogEntry,
  findFavoriteForEntry,
  foodFavoriteKey,
  type FoodFavoriteDto,
} from './food.js'

function fav(over: Partial<FoodFavoriteDto> = {}): FoodFavoriteDto {
  return {
    id: 'ffav_1',
    foodItemId: null,
    name: 'Greek yogurt',
    quantityGrams: 170,
    quantityUnit: null,
    quantityAmount: null,
    kcal: 100,
    proteinG: 17,
    carbsG: 6,
    fatG: 0.7,
    source: 'manual',
    createdAt: '2026-08-18T12:00:00.000Z',
    ...over,
  }
}

describe('foodFavoriteKey', () => {
  it('ignores case and surrounding whitespace in the name', () => {
    expect(foodFavoriteKey({ name: '  Greek Yogurt ', quantityGrams: 170, kcal: 100 })).toBe(
      foodFavoriteKey({ name: 'greek yogurt', quantityGrams: 170, kcal: 100 }),
    )
  })

  it('rounds kcal to the nearest whole so display rounding never splits a pin', () => {
    expect(foodFavoriteKey({ name: 'x', quantityGrams: 10, kcal: 100.4 })).toBe(
      foodFavoriteKey({ name: 'x', quantityGrams: 10, kcal: 100 }),
    )
    expect(foodFavoriteKey({ name: 'x', quantityGrams: 10, kcal: 100.6 })).not.toBe(
      foodFavoriteKey({ name: 'x', quantityGrams: 10, kcal: 100 }),
    )
  })

  it('treats missing grams as distinct from zero-ish grams', () => {
    const noGrams = foodFavoriteKey({ name: 'x', quantityGrams: null, kcal: 50 })
    expect(noGrams).not.toBe(foodFavoriteKey({ name: 'x', quantityGrams: 0.1, kcal: 50 }))
    expect(noGrams).toBe(foodFavoriteKey({ name: 'x', kcal: 50 }))
  })

  it('separates the fields so concatenation can not collide', () => {
    expect(foodFavoriteKey({ name: 'a b', quantityGrams: 1, kcal: 2 })).not.toBe(
      foodFavoriteKey({ name: 'a', quantityGrams: null, kcal: 2 }),
    )
  })
})

describe('findFavoriteForEntry', () => {
  const favorites = [fav(), fav({ id: 'ffav_2', name: 'Oatmeal', quantityGrams: 80, kcal: 300 })]

  it('matches a diary row on name, grams and kcal', () => {
    const hit = findFavoriteForEntry(favorites, {
      name: 'Oatmeal',
      quantityGrams: 80,
      kcal: 300,
    })
    expect(hit?.id).toBe('ffav_2')
  })

  it('returns null when the quantity differs', () => {
    expect(
      findFavoriteForEntry(favorites, { name: 'Oatmeal', quantityGrams: 120, kcal: 300 }),
    ).toBeNull()
  })

  it('returns null when the name differs', () => {
    expect(
      findFavoriteForEntry(favorites, { name: 'Oat milk', quantityGrams: 80, kcal: 300 }),
    ).toBeNull()
  })

  it('matches gram-less entries', () => {
    const list = [fav({ id: 'ffav_3', name: 'Coffee', quantityGrams: null, kcal: 5 })]
    expect(
      findFavoriteForEntry(list, { name: 'Coffee', quantityGrams: null, kcal: 5 })?.id,
    ).toBe('ffav_3')
  })
})

describe('favoriteToLogEntry', () => {
  const at = '2026-08-18T18:30:00.000Z'

  it('carries the snapshot onto a valid create payload', () => {
    const input = favoriteToLogEntry(fav({ foodItemId: 'ff_abc' }), at)
    expect(input).toMatchObject({
      loggedAt: at,
      foodItemId: 'ff_abc',
      name: 'Greek yogurt',
      quantityGrams: 170,
      kcal: 100,
      source: 'manual',
    })
    expect(createFoodLogEntrySchema.safeParse(input).success).toBe(true)
  })

  it('keeps the as-typed unit pair together', () => {
    const input = favoriteToLogEntry(
      fav({ quantityGrams: 240, quantityUnit: 'cup', quantityAmount: 1 }),
      at,
    )
    expect(input.quantityUnit).toBe('cup')
    expect(input.quantityAmount).toBe(1)
    expect(createFoodLogEntrySchema.safeParse(input).success).toBe(true)
  })

  it('omits the unit pair entirely when the entry was logged in grams', () => {
    const input = favoriteToLogEntry(fav(), at)
    expect('quantityUnit' in input).toBe(false)
    expect('quantityAmount' in input).toBe(false)
  })

  it('degrades a prepared-meal pin to a manual entry', () => {
    // Re-logging a template must not decrement a meal-prep batch, and
    // the create schema has no preparedMealId to carry anyway.
    const input = favoriteToLogEntry(fav({ source: 'prepared_meal' }), at)
    expect(input.source).toBe('manual')
    expect(createFoodLogEntrySchema.safeParse(input).success).toBe(true)
  })

  it('drops photo estimation tracking so the payload still validates', () => {
    const input = favoriteToLogEntry(fav({ source: 'photo' }), at)
    expect('estimatedGrams' in input).toBe(false)
    expect('scanResponseId' in input).toBe(false)
    expect(createFoodLogEntrySchema.safeParse(input).success).toBe(true)
  })

  // Every source has to survive the round trip, not just the three the
  // cases above happen to name — a future source-specific rule in
  // createFoodLogEntrySchema (like the existing photo/text restriction
  // on estimatedGrams) would otherwise break re-logging silently.
  it.each(FOOD_LOG_SOURCES)('re-logs a %s pin as a valid payload', (source) => {
    const parsed = createFoodLogEntrySchema.safeParse(favoriteToLogEntry(fav({ source }), at))
    expect(parsed.success).toBe(true)
  })

  it('omits foodItemId when the favorite has no catalog provenance', () => {
    const input = favoriteToLogEntry(fav({ foodItemId: null }), at)
    expect('foodItemId' in input).toBe(false)
  })
})

describe('createFoodFavoriteSchema', () => {
  const base = { name: 'Greek yogurt', kcal: 100, proteinG: 17, carbsG: 6, fatG: 0.7 }

  it('accepts a gram-only snapshot', () => {
    expect(
      createFoodFavoriteSchema.safeParse({ ...base, quantityGrams: 170, source: 'manual' })
        .success,
    ).toBe(true)
  })

  it('accepts a snapshot with no quantity at all', () => {
    expect(createFoodFavoriteSchema.safeParse({ ...base, source: 'text' }).success).toBe(true)
  })

  it('rejects a half-specified unit pair', () => {
    expect(
      createFoodFavoriteSchema.safeParse({
        ...base,
        quantityGrams: 240,
        quantityUnit: 'cup',
        source: 'manual',
      }).success,
    ).toBe(false)
  })

  it('rejects a unit pair with no canonical grams', () => {
    expect(
      createFoodFavoriteSchema.safeParse({
        ...base,
        quantityUnit: 'cup',
        quantityAmount: 1,
        source: 'manual',
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown source', () => {
    expect(
      createFoodFavoriteSchema.safeParse({ ...base, source: 'telepathy' }).success,
    ).toBe(false)
  })
})
