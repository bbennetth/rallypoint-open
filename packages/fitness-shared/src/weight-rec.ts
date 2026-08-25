// Per-set weight recommender for the live strength engine. Pure
// function: takes the lift's most recent top set + a (possibly empty)
// list of fatigued muscle groups, returns a suggested kg load and a
// human-readable basis line for the `.rec-line` strip.
//
// Heuristic (per the design handoff README):
//   1. From the recent top set (reps, kg) compute an Epley-style 1RM:
//        1RM ≈ kg × (1 + reps / 30)
//   2. Target a rep-based working percentage `pct(reps) × 0.97`.
//      The 0.97 factor pulls the suggestion just under the rep-pct
//      curve so a typical "easy first set" lands at the right effort.
//   3. Bias toward the most recent working weight with a small
//      progression bump when target reps stay below the previous set.
//   4. Trim 5 % if any primary muscle group is in the user's top-N
//      weekly volume ("muscle loaded" tag).
//   5. Round to the nearest 2.5 kg plate.
//
// Returns null when there is no recent set to anchor on — the UI
// surfaces a "no suggestion yet" hint instead.

const ROUND_TO_KG = 2.5

function roundToPlate(kg: number): number {
  return Math.max(0, Math.round(kg / ROUND_TO_KG) * ROUND_TO_KG)
}

/** Approximate 1RM percentage you can lift for `reps` clean reps.
 *  Curve fit to the Epley table; capped at 100 % for a single rep. */
function pctForReps(reps: number): number {
  if (reps <= 1) return 1
  if (reps >= 12) return 0.7
  // Smooth interpolation: pct = 1 - 0.025 * (reps - 1)
  const x = 1 - 0.025 * (reps - 1)
  return Math.max(0.7, Math.min(1, x))
}

function epleyOneRm(loadKg: number, reps: number): number {
  if (reps <= 0 || loadKg <= 0) return 0
  if (reps === 1) return loadKg
  return loadKg * (1 + reps / 30)
}

export interface RecentTopSet {
  reps: number
  loadKg: number
}

export interface WeightRecOptions {
  /** Slugs of muscle groups in the user's weekly top-2 volume. The
   *  caller computes this from getVolumeInsights; pass an empty
   *  array when not known. */
  fatiguedGroupIds?: readonly string[]
  /** Primary-muscle slugs the lift recruits. The recommender trims
   *  5 % when any primary belongs to `fatiguedGroupIds`. */
  primaryGroupIds?: readonly string[]
}

export interface WeightRecommendation {
  kg: number
  basis: string
  /** True when the load was trimmed for accumulated weekly volume. */
  fatigued: boolean
}

export function recommendLoad(
  targetReps: number,
  recentTopSet: RecentTopSet | null,
  opts: WeightRecOptions = {},
): WeightRecommendation | null {
  if (!recentTopSet) return null
  const { reps: lastReps, loadKg: lastKg } = recentTopSet
  if (lastKg <= 0 || lastReps <= 0 || targetReps <= 0) return null

  const oneRm = epleyOneRm(lastKg, lastReps)
  const targetPct = pctForReps(targetReps) * 0.97
  const fromOneRm = oneRm * targetPct

  // Bias toward last weight + a small progression bump when this set
  // is meant to be lighter than the previous one (lower reps usually
  // means heavier, so the bump only applies when reps go DOWN).
  const bumped = targetReps < lastReps ? lastKg + ROUND_TO_KG : lastKg
  // Weighted blend: 60% recent weight, 40% 1RM-derived. Keeps the
  // suggestion grounded in what the user actually moves while still
  // tracking the 1RM curve.
  let kg = bumped * 0.6 + fromOneRm * 0.4

  const fatigued = Boolean(
    opts.fatiguedGroupIds &&
      opts.primaryGroupIds &&
      opts.primaryGroupIds.some((g) => opts.fatiguedGroupIds!.includes(g)),
  )
  if (fatigued) kg *= 0.95
  kg = roundToPlate(kg)

  let basis = `last ${lastKg}`
  if (targetReps < lastReps) basis += ` +${ROUND_TO_KG}`
  if (fatigued) basis += ' · muscle loaded'

  return { kg, basis, fatigued }
}
