import { describe, expect, it } from 'vitest'
import {
  G_PER_OZ,
  MASS_ONLY_UNIT_CTX,
  ML_PER_CUP,
  fromGrams,
  toGrams,
  unitLabel,
  unitOptionsFor,
  type FoodUnitContext,
} from './food-units.js'

const solidWithServing: FoodUnitContext = { servingGrams: 45, isLiquid: false }
const liquidWithServing: FoodUnitContext = { servingGrams: 240, isLiquid: true }
const liquidNoServing: FoodUnitContext = { servingGrams: null, isLiquid: true }

describe('unitOptionsFor', () => {
  it('offers mass units only for unknown foods', () => {
    expect(unitOptionsFor(MASS_ONLY_UNIT_CTX)).toEqual(['g', 'oz'])
  })

  it('adds serving when a serving weight is known', () => {
    expect(unitOptionsFor(solidWithServing)).toEqual(['g', 'oz', 'serving'])
  })

  it('adds volume units for liquids, with or without a serving', () => {
    expect(unitOptionsFor(liquidWithServing)).toEqual([
      'g',
      'oz',
      'serving',
      'ml',
      'fl_oz',
      'cup',
    ])
    expect(unitOptionsFor(liquidNoServing)).toEqual(['g', 'oz', 'ml', 'fl_oz', 'cup'])
  })

  it('treats a non-positive serving weight as no serving', () => {
    expect(unitOptionsFor({ servingGrams: 0, isLiquid: false })).toEqual(['g', 'oz'])
  })
})

describe('toGrams', () => {
  it('converts each unit to canonical grams (1 dp)', () => {
    expect(toGrams(100, 'g', MASS_ONLY_UNIT_CTX)).toBe(100)
    expect(toGrams(2, 'oz', MASS_ONLY_UNIT_CTX)).toBe(Math.round(2 * G_PER_OZ * 10) / 10)
    expect(toGrams(1.5, 'serving', solidWithServing)).toBe(67.5)
    expect(toGrams(240, 'ml', liquidNoServing)).toBe(240)
    expect(toGrams(1, 'cup', liquidNoServing)).toBe(236.6)
    expect(toGrams(8, 'fl_oz', liquidNoServing)).toBe(236.6)
  })

  it('rejects units that do not apply to the food', () => {
    expect(toGrams(1, 'serving', MASS_ONLY_UNIT_CTX)).toBeNull()
    expect(toGrams(1, 'cup', solidWithServing)).toBeNull()
    expect(toGrams(1, 'ml', MASS_ONLY_UNIT_CTX)).toBeNull()
  })

  it('rejects non-positive and non-finite amounts', () => {
    expect(toGrams(0, 'g', MASS_ONLY_UNIT_CTX)).toBeNull()
    expect(toGrams(-1, 'oz', MASS_ONLY_UNIT_CTX)).toBeNull()
    expect(toGrams(NaN, 'g', MASS_ONLY_UNIT_CTX)).toBeNull()
    expect(toGrams(Infinity, 'g', MASS_ONLY_UNIT_CTX)).toBeNull()
  })
})

describe('fromGrams', () => {
  it('converts grams to a display amount with per-unit rounding', () => {
    expect(fromGrams(240, 'g', liquidNoServing)).toBe(240)
    expect(fromGrams(240, 'ml', liquidNoServing)).toBe(240)
    expect(fromGrams(240, 'cup', liquidNoServing)).toBe(1.01) // 2 dp
    expect(fromGrams(240, 'fl_oz', liquidNoServing)).toBe(8.1) // 1 dp
    expect(fromGrams(45, 'serving', solidWithServing)).toBe(1)
    expect(fromGrams(56.7, 'oz', MASS_ONLY_UNIT_CTX)).toBe(2)
  })

  it('round-trips a typed amount through grams without drift', () => {
    const grams = toGrams(1, 'cup', liquidNoServing)!
    expect(grams).toBe(Math.round(ML_PER_CUP * 10) / 10)
    expect(fromGrams(grams, 'cup', liquidNoServing)).toBe(1)
    const oz = toGrams(3.5, 'oz', MASS_ONLY_UNIT_CTX)!
    expect(fromGrams(oz, 'oz', MASS_ONLY_UNIT_CTX)).toBe(3.5)
  })

  it('rejects invalid grams and inapplicable units', () => {
    expect(fromGrams(0, 'g', MASS_ONLY_UNIT_CTX)).toBeNull()
    expect(fromGrams(NaN, 'g', MASS_ONLY_UNIT_CTX)).toBeNull()
    expect(fromGrams(100, 'serving', MASS_ONLY_UNIT_CTX)).toBeNull()
    expect(fromGrams(100, 'cup', MASS_ONLY_UNIT_CTX)).toBeNull()
  })
})

describe('unitLabel', () => {
  it('renders fl_oz with a space, everything else verbatim', () => {
    expect(unitLabel('fl_oz')).toBe('fl oz')
    expect(unitLabel('g')).toBe('g')
    expect(unitLabel('serving')).toBe('serving')
    expect(unitLabel('cup')).toBe('cup')
  })
})
