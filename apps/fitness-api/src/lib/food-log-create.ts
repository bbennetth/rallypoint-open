import type { CreateFoodLogEntryInput } from '@rallypoint/fitness-shared'
import type { NewFoodLogEntry } from '../repos/types.js'

// Assemble the diary-row create object from the validated POST /food/log
// body. The id is minted by the caller (route owns the `fl_` prefix) so
// this stays deterministic. Optional fields are conditionally assigned —
// absent on the body means absent on the create, never `undefined`-valued.
export function buildFoodLogCreate(
  userId: string,
  id: string,
  body: CreateFoodLogEntryInput,
): NewFoodLogEntry {
  const create: NewFoodLogEntry = {
    id,
    userId,
    loggedAt: new Date(body.loggedAt),
    name: body.name,
    kcal: body.kcal,
    proteinG: body.proteinG,
    carbsG: body.carbsG,
    fatG: body.fatG,
    source: body.source,
  }
  if (body.foodItemId !== undefined) create.foodItemId = body.foodItemId
  if (body.quantityGrams !== undefined) create.quantityGrams = body.quantityGrams
  if (body.quantityUnit !== undefined) create.quantityUnit = body.quantityUnit
  if (body.quantityAmount !== undefined) create.quantityAmount = body.quantityAmount
  if (body.estimatedGrams !== undefined) create.estimatedGrams = body.estimatedGrams
  if (body.scanResponseId !== undefined) create.scanResponseId = body.scanResponseId
  if (body.note !== undefined) create.note = body.note
  return create
}

// The reusable cache row's per-100g is derived server-side from the
// reviewed log values (the schema guarantees positive grams for both
// save modes), so the cache stores what the user confirmed. Both the
// private-custom and shared-UPC paths use the same derivation.
export function derivePer100g(
  macros: { kcal: number; proteinG: number; carbsG: number; fatG: number },
  grams: number,
): { kcal: number; proteinG: number; carbsG: number; fatG: number } {
  return {
    kcal: (macros.kcal * 100) / grams,
    proteinG: (macros.proteinG * 100) / grams,
    carbsG: (macros.carbsG * 100) / grams,
    fatG: (macros.fatG * 100) / grams,
  }
}
