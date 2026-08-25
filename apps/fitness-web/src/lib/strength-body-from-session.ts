// Pure mapping from a live strength session's blocks to a strength
// TEMPLATE body — the shape both `createWodTemplate` and
// `patchWodTemplate` accept. Extracted from StrengthSessionPage's
// inline save-as-template builder so the create and update paths share
// one implementation (and the F11 rules stay unit-tested):
//
// - Unit resolution defers to the shared strengthSetUnit (explicit
//   hint > field-priority inference) so the save + template paths
//   agree with the live UI.
// - A set with no positive amount in its unit is dropped, never
//   fabricated.
// - Bodyweight loadKg=0 survives — 0 is a meaningful value, not a
//   sentinel for "missing"; only null (no load entered) is omitted.

import type { StrengthBody, StrengthSessionState } from '@rallypoint/fitness-shared'
import { strengthSetUnit } from '@rallypoint/fitness-shared'

export function strengthBodyFromSession(state: StrengthSessionState): StrengthBody {
  return {
    kind: 'strength',
    blocks: state.blocks.map((b) => ({
      exerciseId: b.exerciseId,
      name: b.name,
      sets: b.sets.flatMap((s): StrengthBody['blocks'][number]['sets'] => {
        const field = strengthSetUnit(s)
        const amount = s[field]
        if (amount == null || amount <= 0) return []
        if (field !== 'reps') {
          return [{ [field]: amount }]
        }
        const target: { reps: number; loadKg?: number } = { reps: amount }
        if (s.loadKg != null) target.loadKg = s.loadKg
        return [target]
      }),
    })),
  }
}
