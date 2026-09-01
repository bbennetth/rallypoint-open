// Pure view-model for the live strength page's SUGGESTED rec-line.
// Owns the display rules the JSX shouldn't: snap the suggestion to the
// display unit's plate increment (5 lb / 2.5 kg — the kg-rounded
// recommender lands on odd lb numbers otherwise) and rebuild the basis
// line in the athlete's display unit from the structured suggestion
// fields (`suggestedBasis` itself is kg-denominated; pre-prefill
// persisted snapshots lack the fields and fall back to the string).
// Bare numbers in the basis — the adjacent suggestion carries the unit —
// and the bump is the difference of the DISPLAY values rather than an
// independently rounded conversion. NB the headline is a snapped BLEND
// (weight-rec.ts: "`kg` is a blend of `lastKg + bumpKg` and the 1RM
// curve, not their sum"), so `last + bump` need not equal `shown`; the
// bump advertises the recommender's progression step and is suppressed
// whenever the headline doesn't actually rise above `last`.
//
// The strip renders whenever a suggestion exists — even when it matches
// the prefilled rows. The old hide-when-duplicate rule predates the
// last-session prefill: now that rows prefill to last values and the
// suggestion is usually anchored on the same session, "duplicate" is
// the COMMON case, and hiding read as "no suggestion" (user report,
// 2026-09-01). With the Use affordance attached, a matching strip reads
// as confirmation instead of noise.

import type { StrengthBlock, StrengthSet } from '@rallypoint/fitness-shared'
import { setTakesSuggestedLoad } from '@rallypoint/fitness-shared'
import { kgToDisplay, snapLoadToIncrement, type WeightUnit } from './units.js'

export interface RecLineView {
  /** The suggested load, snapped to the display unit's plate increment
   *  (5 lb / 2.5 kg) and formatted with unit ("102.5 kg" / "225 lb"). */
  shown: string
  /** Storage-kg equivalent of `shown` — what accepting the suggestion
   *  writes, so the rows land on exactly the number the strip showed. */
  applyKg: number
  /** "last 100 +2.5" style basis in display-unit numbers, or null. */
  basis: string | null
}

/** Whether the Use pill should render: some set would actually change if
 *  the suggestion were applied. Base eligibility is the shared
 *  setTakesSuggestedLoad (the reducer's own filter, so pill and action
 *  can't disagree); the load term drops the pill once every fillable set
 *  already carries the suggestion — including right after a press. */
export function canApplySuggestion(
  block: {
    sets: ReadonlyArray<
      Pick<StrengthSet, 'reps' | 'calories' | 'distanceM' | 'timeS' | 'unit' | 'done' | 'setType' | 'loadKg'>
    >
  },
  applyKg: number,
): boolean {
  return block.sets.some((s) => setTakesSuggestedLoad(s) && s.loadKg !== applyKg)
}

export function recLineView(
  block: Pick<StrengthBlock, 'suggestedKg' | 'suggestedBasis'> & {
    suggestedLastKg?: number | null
    suggestedBumpKg?: number | null
  },
  unit: WeightUnit,
): RecLineView | null {
  if (block.suggestedKg == null) return null
  const snap = snapLoadToIncrement(block.suggestedKg, unit)
  // The snapped display number drives the string directly — no reliance
  // on the display→kg→display round-trip holding.
  const shown = `${snap.display} ${unit}`
  const applyKg = snap.kg
  if (block.suggestedLastKg == null) return { shown, applyKg, basis: block.suggestedBasis }
  const last = kgToDisplay(block.suggestedLastKg, unit)
  let basis = `last ${last}`
  if (block.suggestedBumpKg != null) {
    const bump =
      Math.round(
        (kgToDisplay(block.suggestedLastKg + block.suggestedBumpKg, unit) - last) * 100,
      ) / 100
    // Suppressed when the snap landed back ON (or below) the last
    // weight — "95 lb · last 95 +5" would advertise a bump the headline
    // doesn't carry.
    if (bump > 0 && snap.display > last) basis += ` +${bump}`
  }
  return { shown, applyKg, basis }
}
