import { describe, expect, it } from 'vitest'
import {
  MIXERS_BUILTIN,
  POUR_STRENGTHS,
  SPIRITS,
  computeMixedDrink,
  drinkScanResultSchema,
  matchMixerGuess,
  matchSpiritGuess,
  mixerFromFoodItem,
  spiritKcalPerShot,
} from './alcohol.js'
import type { FoodItemDto } from './food.js'

const spirit = (id: string) => SPIRITS.find((s) => s.id === id)!
const mixer = (id: string) => MIXERS_BUILTIN.find((m) => m.id === id)!
const strength = (id: string) => POUR_STRENGTHS.find((p) => p.id === id)!

describe('spiritKcalPerShot', () => {
  it('is ~97 kcal for a 40% shot', () => {
    expect(Math.round(spiritKcalPerShot(0.4))).toBe(97)
  })

  it('scales linearly with ABV', () => {
    expect(spiritKcalPerShot(0.5)).toBeCloseTo(spiritKcalPerShot(0.4) * 1.25, 5)
  })
})

describe('computeMixedDrink', () => {
  it('gay pour of vodka + diet soda ≈ 3 shots, no mixer calories', () => {
    const drink = computeMixedDrink({
      spirit: spirit('vodka'),
      strength: strength('gay'),
      mixer: mixer('diet-soda'),
      mixerMl: 200,
    })
    expect(drink.shots).toBe(3)
    expect(drink.kcal).toBe(292) // 3 × 97.2 rounded
    expect(drink.carbsG).toBe(0)
    expect(drink.proteinG).toBe(0)
    expect(drink.fatG).toBe(0)
    expect(drink.volumeMl).toBe(332) // 3×44 + 200
    expect(drink.name).toBe('Vodka + Diet soda')
  })

  it('adds mixer calories from the poured volume', () => {
    const drink = computeMixedDrink({
      spirit: spirit('rum'),
      strength: strength('single'),
      mixer: mixer('cola'),
      mixerMl: 150,
    })
    // 1 shot rum (~97) + 150ml cola (42/100ml = 63 kcal) = 160
    expect(drink.kcal).toBe(160)
    expect(drink.carbsG).toBe(15.9) // 150/100 × 10.6
  })

  it('treats a neat pour as zero mixer volume regardless of mixerMl', () => {
    const drink = computeMixedDrink({
      spirit: spirit('whiskey'),
      strength: strength('double'),
      mixer: mixer('none'),
      mixerMl: 500,
    })
    expect(drink.kcal).toBe(194) // 2 × 97.2
    expect(drink.carbsG).toBe(0)
    expect(drink.volumeMl).toBe(88) // 2×44, no mixer
    expect(drink.name).toBe('Whiskey')
  })

  it('clamps a negative mixer volume to zero', () => {
    const drink = computeMixedDrink({
      spirit: spirit('gin'),
      strength: strength('single'),
      mixer: mixer('tonic'),
      mixerMl: -100,
    })
    expect(drink.carbsG).toBe(0)
    expect(drink.kcal).toBe(97)
  })

  it('reports grams of pure ethanol', () => {
    const drink = computeMixedDrink({
      spirit: spirit('vodka'),
      strength: strength('single'),
      mixer: mixer('none'),
      mixerMl: 0,
    })
    expect(drink.alcoholG).toBeCloseTo(13.9, 1) // 44 × 0.4 × 0.789
  })
})

describe('mixerFromFoodItem', () => {
  it('reads a liquid food item as a per-100ml mixer', () => {
    const item: FoodItemDto = {
      id: 'ff_x',
      upc: '111',
      source: 'off',
      name: 'Diet Cola',
      brand: 'Store',
      servingGrams: 355,
      servingQuantity: 355,
      servingUnit: 'ml',
      isLiquid: true,
      per100g: { kcal: 1, proteinG: 0, carbsG: 0.2, fatG: 0 },
    }
    const m = mixerFromFoodItem(item)
    expect(m).toEqual({ id: 'ff_x', name: 'Diet Cola', kcalPer100ml: 1, carbsPer100ml: 0.2 })
  })
})

describe('vision guess matching', () => {
  it('matches spirit guesses by id, exact name, or substring', () => {
    expect(matchSpiritGuess('vodka')?.id).toBe('vodka')
    expect(matchSpiritGuess('a bottle of Grey Goose vodka')?.id).toBe('vodka')
    expect(matchSpiritGuess('Whiskey')?.id).toBe('whiskey')
    expect(matchSpiritGuess('absinthe')).toBeNull()
    expect(matchSpiritGuess(null)).toBeNull()
    expect(matchSpiritGuess('')).toBeNull()
  })

  it('matches mixer guesses but never resolves to the neat sentinel', () => {
    expect(matchMixerGuess('cola')?.id).toBe('cola')
    expect(matchMixerGuess('looks like orange juice')?.id).toBe('orange-juice')
    expect(matchMixerGuess('none')).toBeNull()
    expect(matchMixerGuess('neat')).toBeNull()
  })
})

describe('drinkScanResultSchema', () => {
  it('accepts a well-formed guess and rejects a bad confidence', () => {
    expect(
      drinkScanResultSchema.safeParse({ spirit: 'vodka', mixer: null, confidence: 'high' }).success,
    ).toBe(true)
    expect(
      drinkScanResultSchema.safeParse({ spirit: null, mixer: null, confidence: 'sure' }).success,
    ).toBe(false)
  })
})
