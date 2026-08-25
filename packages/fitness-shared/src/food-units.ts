// Quantity units for the food logger. STORAGE IS ALWAYS GRAMS
// (quantityGrams) — units are a pure conversion layer at the input
// edge, mirroring the kg/lb and m/mi contracts in fitness-web's
// units.ts. Which units make sense depends on the product: mass units
// always work; 'serving' needs a known serving weight; volume units
// (ml / fl oz / cup) are offered only for ml-basis products, where we
// take 1 g = 1 ml — OFF liquid nutriments are published per 100ml and
// stored in our per-100g columns unchanged, so the identity is already
// the data model's assumption, not a new approximation.

export const FOOD_QUANTITY_UNITS = ['g', 'oz', 'serving', 'ml', 'fl_oz', 'cup'] as const
export type FoodQuantityUnit = (typeof FOOD_QUANTITY_UNITS)[number]

export const G_PER_OZ = 28.3495
export const ML_PER_FL_OZ = 29.5735
export const ML_PER_CUP = 236.588

// What the unit picker needs to know about a food. Both fields null/
// false for manual and photo entries (mass units only).
export interface FoodUnitContext {
  // Grams per 1 serving (ml-basis servings pre-converted at 1 g/ml).
  servingGrams: number | null
  // ml-basis product: volume units offered, 1 g = 1 ml.
  isLiquid: boolean
}

export const MASS_ONLY_UNIT_CTX: FoodUnitContext = { servingGrams: null, isLiquid: false }

// The units that make sense for this food, in picker order.
export function unitOptionsFor(ctx: FoodUnitContext): FoodQuantityUnit[] {
  const out: FoodQuantityUnit[] = ['g', 'oz']
  if (ctx.servingGrams !== null && ctx.servingGrams > 0) out.push('serving')
  if (ctx.isLiquid) out.push('ml', 'fl_oz', 'cup')
  return out
}

function gramsPerUnit(unit: FoodQuantityUnit, ctx: FoodUnitContext): number | null {
  switch (unit) {
    case 'g':
      return 1
    case 'oz':
      return G_PER_OZ
    case 'serving':
      return ctx.servingGrams !== null && ctx.servingGrams > 0 ? ctx.servingGrams : null
    case 'ml':
      return ctx.isLiquid ? 1 : null
    case 'fl_oz':
      return ctx.isLiquid ? ML_PER_FL_OZ : null
    case 'cup':
      return ctx.isLiquid ? ML_PER_CUP : null
  }
}

// Convert a user-entered amount to canonical grams (1 dp). Null when
// the amount isn't a positive finite number or the unit doesn't apply
// to this food (e.g. 'serving' with no known serving weight).
export function toGrams(
  amount: number,
  unit: FoodQuantityUnit,
  ctx: FoodUnitContext,
): number | null {
  if (!isFinite(amount) || amount <= 0) return null
  const per = gramsPerUnit(unit, ctx)
  if (per === null) return null
  return Math.round(amount * per * 10) / 10
}

// Convert canonical grams to a display amount. Coarse units that users
// think of fractionally (serving, cup) keep 2 dp; the rest 1 dp. Only
// ever used to render — grams is never recomputed from its output, so
// unit switches can't accumulate rounding drift.
export function fromGrams(
  grams: number,
  unit: FoodQuantityUnit,
  ctx: FoodUnitContext,
): number | null {
  if (!isFinite(grams) || grams <= 0) return null
  const per = gramsPerUnit(unit, ctx)
  if (per === null) return null
  const dp = unit === 'serving' || unit === 'cup' ? 100 : 10
  return Math.round((grams / per) * dp) / dp
}

export function unitLabel(unit: FoodQuantityUnit): string {
  return unit === 'fl_oz' ? 'fl oz' : unit
}
