// Pure helpers for reconstructing a strength-template body from a
// logged workout's sets. Extracted from WorkoutDetailSheet (S7) so
// the filtering rules — null/zero-rep sets drop, bodyweight (loadKg=0)
// survives — live in one place with unit tests.
//
// Background: previously the build used `reps ?? 1` (fabricating a
// rep count for duration-only sets) and `loadKg > 0` (silently
// dropping bodyweight 0). The first corrupts the saved template; the
// second loses information the live UI displays correctly. Both are
// in the same code-review finding band (F11).

import type { StrengthBody } from '@rallypoint/fitness-shared'

export interface BuildInputSet {
  reps: number | null
  loadKg: number | null
}

export interface BuildInputBlock {
  exerciseId: string
  exerciseName: string
  sets: BuildInputSet[]
}

/** A set is rep-usable when reps is present and positive. Null and 0
 *  reps mean either "duration-only" (no rep target, useless in a
 *  template) or a half-typed set; either way the template can't
 *  represent it without fabrication, so we exclude it. */
export function isRepUsableSet(s: BuildInputSet): boolean {
  return s.reps != null && s.reps > 0
}

/** Filter a block's sets to the rep-usable subset. Returns null when
 *  the block ends up empty — the caller drops null blocks. */
export function filterUsableBlock(b: BuildInputBlock): BuildInputBlock | null {
  const usable = b.sets.filter(isRepUsableSet)
  if (usable.length === 0) return null
  return { ...b, sets: usable }
}

/** True when there's at least one block that survives filtering. The
 *  Save-as-template button uses this to disable itself on workouts
 *  that have no rep-bearing sets at all (e.g. a pure duration-only
 *  session) — silently shipping a template with fabricated `reps=1`
 *  rows was the F11 corruption. */
export function hasUsableStrengthSets(blocks: readonly BuildInputBlock[]): boolean {
  return blocks.some((b) => b.sets.some(isRepUsableSet))
}

/** Build a strength template body from the input blocks. Drops
 *  null-reps sets and bodyweight (loadKg=0) is preserved — the
 *  caller should have already gated on `hasUsableStrengthSets` to
 *  avoid an empty `blocks` array, which `strengthBodySchema` rejects. */
export function buildStrengthTemplateBody(
  blocks: readonly BuildInputBlock[],
): StrengthBody {
  return {
    kind: 'strength',
    blocks: blocks
      .map(filterUsableBlock)
      .filter((b): b is BuildInputBlock => b !== null)
      .map((b) => ({
        exerciseId: b.exerciseId,
        name: b.exerciseName,
        sets: b.sets.map((s) => {
          // reps is non-null because of the `isRepUsableSet` filter.
          const target: { reps: number; loadKg?: number } = { reps: s.reps! }
          // Bodyweight: loadKg=0 is meaningful (a pull-up), not a
          // sentinel for missing. Preserve it; only omit on null.
          if (s.loadKg != null) target.loadKg = s.loadKg
          return target
        }),
      })),
  }
}
