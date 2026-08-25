// Pure logic for turning an approved food submission's snapshot into a
// curated-global food_items create decision. No DB access here — the
// caller (services/food-submission-review.ts) resolves the "does a
// global food_items row with this upc already exist?" question via the
// repo and passes the answer in, so this stays a plain, easily
// unit-tested function. Mirrors lib/submission-promote.ts (exercise
// submissions) in shape.

export type PlanFoodPromotionResult =
  | { kind: 'create' }
  | { kind: 'link'; existingGlobalFoodItemId: string }

// `existingGlobalFoodItemId` is the id of a global food_items row that
// already carries this submission's upc, or null when none exists.
// Returns a 'link' signal (never throws) so the caller can link the
// submission to the existing row instead of creating a second one for
// the same barcode.
export function planFoodPromotion(
  existingGlobalFoodItemId: string | null,
): PlanFoodPromotionResult {
  if (existingGlobalFoodItemId) {
    return { kind: 'link', existingGlobalFoodItemId }
  }
  return { kind: 'create' }
}
