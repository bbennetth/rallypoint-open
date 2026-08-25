// Cross-target weight conversion. STORAGE IS ALWAYS KG — every DTO field
// (loadKg, tonnageKg, …) keeps its unit; only the render/input edge
// converts. The constant lives here rather than in fitness-web's units.ts
// so the server can share it: the whiteboard scan reads a load off a board
// written in pounds ("155/105 lbs") and has to normalize it to kg before
// the value ever leaves the API. Two copies of the factor would be a
// divergent-copy bug waiting to happen, so units.ts re-exports this one.

export const KG_PER_LB = 0.45359237

/** The unit a load was written in — on a whiteboard, in a form field.
 *  Structurally identical to fitness-web's `WeightUnit`, so the two
 *  assign to each other without a cast. */
export type LoadUnit = 'lb' | 'kg'

/** Normalize a load read off a whiteboard into storage kg.
 *
 *  The lb branch is the same formula as fitness-web's `displayToKg`, so a
 *  scanned 155 lb and a hand-typed 155 lb produce the identical stored
 *  value (70.31 kg) and round-trip back through `kgToDisplay` to 155.
 *  Without this the vision model would be doing the lb→kg arithmetic
 *  itself, silently and unverifiably.
 *
 *  The kg branch rounds to 2 dp where `displayToKg` passes kg straight
 *  through — a scanned value is an OCR read of a painted number, so
 *  quantizing float noise is right here even though a hand-typed kg load
 *  keeps full precision. */
export function scanLoadToKg(value: number, unit: LoadUnit): number {
  if (!Number.isFinite(value)) return 0
  if (unit === 'kg') return Math.round(value * 100) / 100
  return Math.round(value * KG_PER_LB * 100) / 100
}
