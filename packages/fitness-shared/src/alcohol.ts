import { z } from 'zod'
import type { FoodItemDto } from './food.js'

// Mixed-drink calorie math for the food logger (issue #713). A drink is
// a spirit poured at some strength (single / double / gay = 1 / 2 / 3
// shots) plus an optional mixer volume. Alcohol calories come from the
// ethanol itself; mixer calories come from the mixer's per-100ml block.
// Everything here is pure so the DrinkSheet can preview live and the
// unit tests can pin the arithmetic without a DB or a network call.

// A US "shot" is 1.5 fl oz ≈ 44 ml. Ethanol is 0.789 g/ml and carries
// 7 kcal/g — the textbook Atwater value for alcohol.
export const SHOT_ML = 44
export const ETHANOL_G_PER_ML = 0.789
export const KCAL_PER_G_ALCOHOL = 7

export interface Spirit {
  id: string
  name: string
  // Alcohol by volume as a fraction (0.40 = 40% = 80 proof).
  abv: number
}

export interface Mixer {
  id: string
  name: string
  kcalPer100ml: number
  carbsPer100ml: number
}

export interface PourStrength {
  id: PourStrengthId
  label: string
  shots: number
}

export type PourStrengthId = 'single' | 'double' | 'gay'

// Generic spirits at the standard 40% ABV. The user picks one; a photo
// or UPC path can pre-select via matchSpiritGuess. ABV is what drives
// the calorie math, so a generic "vodka" is close enough for a log.
export const SPIRITS: Spirit[] = [
  { id: 'vodka', name: 'Vodka', abv: 0.4 },
  { id: 'gin', name: 'Gin', abv: 0.4 },
  { id: 'rum', name: 'Rum', abv: 0.4 },
  { id: 'tequila', name: 'Tequila', abv: 0.4 },
  { id: 'whiskey', name: 'Whiskey', abv: 0.4 },
  { id: 'brandy', name: 'Brandy', abv: 0.4 },
]

// The "none" mixer is a neat pour — zero volume, zero calories. Values
// are typical per-100ml figures; a real product can override via
// mixerFromFoodItem (a barcode/search-cached liquid).
export const MIXERS_BUILTIN: Mixer[] = [
  { id: 'none', name: 'Neat / no mixer', kcalPer100ml: 0, carbsPer100ml: 0 },
  { id: 'diet-soda', name: 'Diet soda', kcalPer100ml: 0, carbsPer100ml: 0 },
  { id: 'soda-water', name: 'Soda / club soda', kcalPer100ml: 0, carbsPer100ml: 0 },
  { id: 'cola', name: 'Cola', kcalPer100ml: 42, carbsPer100ml: 10.6 },
  { id: 'tonic', name: 'Tonic water', kcalPer100ml: 34, carbsPer100ml: 8.8 },
  { id: 'orange-juice', name: 'Orange juice', kcalPer100ml: 45, carbsPer100ml: 10.4 },
  { id: 'cranberry-juice', name: 'Cranberry juice', kcalPer100ml: 46, carbsPer100ml: 12 },
]

// Single / double / gay = 1 / 2 / 3 shots. "gay" is the user's own label
// (issue #713) for the heavy gay-bar pour.
export const POUR_STRENGTHS: PourStrength[] = [
  { id: 'single', label: 'Single', shots: 1 },
  { id: 'double', label: 'Double', shots: 2 },
  { id: 'gay', label: 'Gay', shots: 3 },
]

const round1 = (n: number) => Math.round(n * 10) / 10

/** Calories in one shot of a spirit at the given ABV — alcohol only
 *  (pure distilled spirits carry no meaningful carbs/protein/fat). ~97
 *  kcal for a 44 ml shot of 40% vodka. */
export function spiritKcalPerShot(abv: number): number {
  return SHOT_ML * abv * ETHANOL_G_PER_ML * KCAL_PER_G_ALCOHOL
}

export interface MixedDrink {
  name: string
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  // Grams of pure ethanol — surfaced in the log note, not a macro.
  alcoholG: number
  // Total liquid volume (spirit + mixer), for the note.
  volumeMl: number
  shots: number
}

export interface MixedDrinkInput {
  spirit: Spirit
  strength: PourStrength
  mixer: Mixer
  // Mixer volume in ml; ignored for the 'none' (neat) mixer.
  mixerMl: number
}

/** Compute the logged macros for a mixed drink. Spirit contributes only
 *  its alcohol calories; the mixer contributes its per-100ml kcal/carbs
 *  scaled to the poured volume. kcal rounds to a whole number, carbs +
 *  alcohol to one decimal (protein/fat are always 0 for these). */
export function computeMixedDrink(input: MixedDrinkInput): MixedDrink {
  const { spirit, strength, mixer } = input
  const shots = strength.shots
  const isNeat = mixer.id === 'none'
  const mixerMl = isNeat ? 0 : Math.max(0, input.mixerMl)

  const spiritKcal = shots * spiritKcalPerShot(spirit.abv)
  const mixerKcal = (mixerMl / 100) * mixer.kcalPer100ml
  const carbsG = round1((mixerMl / 100) * mixer.carbsPer100ml)
  const alcoholG = round1(SHOT_ML * shots * spirit.abv * ETHANOL_G_PER_ML)

  return {
    name: isNeat ? spirit.name : `${spirit.name} + ${mixer.name}`,
    kcal: Math.round(spiritKcal + mixerKcal),
    proteinG: 0,
    carbsG,
    fatG: 0,
    alcoholG,
    volumeMl: Math.round(SHOT_ML * shots + mixerMl),
    shots,
  }
}

/** Adapt a cached liquid food item (a barcode/search hit for e.g. a
 *  specific diet soda) into a Mixer. Liquid per-100g figures are per
 *  100 ml at 1 g/ml — the same identity the food-units layer already
 *  assumes. */
export function mixerFromFoodItem(item: FoodItemDto): Mixer {
  return {
    id: item.id,
    name: item.name,
    kcalPer100ml: item.per100g.kcal,
    carbsPer100ml: item.per100g.carbsG,
  }
}

// --- photo path (issue #713) ------------------------------------------

// The vision pass for a drink photo returns generic spirit + mixer
// guesses the DrinkSheet maps onto the built-ins as prefill (never a
// final value — the user always confirms the pour).
export const drinkScanResultSchema = z.object({
  spirit: z.string().max(60).nullable(),
  mixer: z.string().max(60).nullable(),
  confidence: z.enum(['low', 'medium', 'high']),
})
export type DrinkScanResult = z.infer<typeof drinkScanResultSchema>

function matchByName<T extends { name: string; id: string }>(
  guess: string | null,
  options: T[],
): T | null {
  if (!guess) return null
  const g = guess.trim().toLowerCase()
  if (g === '') return null
  return (
    options.find((o) => o.name.toLowerCase() === g || o.id === g) ??
    options.find((o) => g.includes(o.id) || o.name.toLowerCase().includes(g) || g.includes(o.name.toLowerCase())) ??
    null
  )
}

/** Map a vision spirit guess ("a bottle of vodka") to a built-in spirit,
 *  or null when nothing matches. */
export function matchSpiritGuess(guess: string | null): Spirit | null {
  return matchByName(guess, SPIRITS)
}

/** Map a vision mixer guess ("looks like cola") to a built-in mixer, or
 *  null when nothing matches. */
export function matchMixerGuess(guess: string | null): Mixer | null {
  // Exclude the 'none' sentinel — a photo guess never means "neat".
  return matchByName(
    guess,
    MIXERS_BUILTIN.filter((m) => m.id !== 'none'),
  )
}
