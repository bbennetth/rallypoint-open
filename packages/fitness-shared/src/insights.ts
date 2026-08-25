// Derived training insights — the cross-sport payoff of the slice-1 muscle
// maps. All PURE functions over logged-set data; the API gathers the rows
// (workout_sets joined to the catalog) and these compute the analytics, so
// there's no insight logic in the handlers and everything is unit-testable.

import { ROLE_VOLUME_WEIGHT, type MuscleRole } from './enums.js'
import { MUSCLES, MUSCLE_GROUPS } from './taxonomy.js'

// muscleId → its group, built once from the taxonomy.
const MUSCLE_TO_GROUP = new Map(MUSCLES.map((m) => [m.id, m.groupId]))

// --- estimated 1RM (Epley) -------------------------------------------

// Epley: 1RM ≈ load × (1 + reps/30). A single rep returns the load itself.
// Returns null when load/reps can't form an estimate.
//
// Accuracy: Epley is well-calibrated for ~1-10 reps and reasonable up to
// ~15. Above ~15 reps it gets fuzzy and progressively over-estimates (a
// 20-rep set with 50 kg yields ~83 kg here vs. ~65-70 kg from more
// conservative formulas). We deliberately do NOT clamp — clamping would
// hide a wonky data point on the trend chart, where the existing tests
// (`pins Epley behavior across rep ranges`) already demonstrate the
// curve so a future reader knows the function makes no accuracy claims
// above 15 reps.
export function estimateOneRepMax(loadKg: number | null, reps: number | null): number | null {
  if (loadKg == null || reps == null || loadKg <= 0 || reps <= 0) return null
  if (reps === 1) return loadKg
  return loadKg * (1 + reps / 30)
}

// --- per-muscle-group volume -----------------------------------------

export interface VolumeSetInput {
  reps: number | null
  loadKg: number | null
  muscles: { muscleId: string; role: string }[]
}

export interface MuscleGroupVolume {
  groupId: string
  groupName: string
  // Σ over sets of the set's strongest role-fraction in this group. The
  // standard "working sets per muscle group" metric, fractionally crediting
  // secondary involvement (primary 1.0, secondary 0.5, stabilizer 0).
  weightedSets: number
  // Σ (reps × load × that same per-set group fraction).
  tonnageKg: number
}

function roleWeight(role: string): number {
  return ROLE_VOLUME_WEIGHT[role as MuscleRole] ?? 0
}

// Aggregate a window of sets into per-muscle-group volume. Each set credits
// a group with its MAX role-fraction among the set's muscles in that group
// (so a bench press counts once toward Chest, not twice for upper+lower).
// Output is ordered by the taxonomy's group sort; groups with no volume are
// included with zeros so the UI can show a complete, stable picture.
export function volumeByMuscleGroup(sets: VolumeSetInput[]): MuscleGroupVolume[] {
  const acc = new Map<string, { weightedSets: number; tonnageKg: number }>()
  for (const g of MUSCLE_GROUPS) acc.set(g.id, { weightedSets: 0, tonnageKg: 0 })

  for (const set of sets) {
    // The strongest role-fraction this set has in each group.
    const groupMax = new Map<string, number>()
    for (const m of set.muscles) {
      // Muscles not in the taxonomy are silently dropped from the
      // aggregation — there is no group to credit them to. The catalog
      // seed-integrity test guards against orphaned muscleIds on the way
      // in, so a drop here means either a manual DB edit or a custom
      // exercise typed past the validator. We accept the silent-drop
      // behavior over a noisy log; insights stay correct for the
      // taxonomy-anchored sets and that's what matters for the trend.
      const groupId = MUSCLE_TO_GROUP.get(m.muscleId)
      if (!groupId) continue
      const w = roleWeight(m.role)
      if (w <= 0) continue
      const prev = groupMax.get(groupId) ?? 0
      if (w > prev) groupMax.set(groupId, w)
    }
    const setTonnage =
      set.reps != null && set.loadKg != null ? set.reps * set.loadKg : 0
    for (const [groupId, w] of groupMax) {
      const a = acc.get(groupId)
      if (!a) continue
      a.weightedSets += w
      a.tonnageKg += setTonnage * w
    }
  }

  return MUSCLE_GROUPS.map((g) => ({
    groupId: g.id,
    groupName: g.name,
    weightedSets: acc.get(g.id)!.weightedSets,
    tonnageKg: acc.get(g.id)!.tonnageKg,
  }))
}

// --- per-muscle volume (drill-down under the group bars) --------------

export interface MuscleVolume {
  muscleId: string
  muscleName: string
  groupId: string
  weightedSets: number
  tonnageKg: number
}

// Same aggregation as volumeByMuscleGroup but keyed by individual muscle —
// no cross-muscle max within a set, since each muscle is its own bucket
// (a duplicate muscleId in one set still counts once at its strongest
// role). Output covers every taxonomy muscle in group-then-muscle sort
// order, zeros included, so drill-down bars are stable across windows.
export function volumeByMuscle(sets: VolumeSetInput[]): MuscleVolume[] {
  const acc = new Map<string, { weightedSets: number; tonnageKg: number }>()
  for (const m of MUSCLES) acc.set(m.id, { weightedSets: 0, tonnageKg: 0 })

  for (const set of sets) {
    // Strongest role-fraction per muscle in this set (dedupe guard; same
    // silent-drop policy for out-of-taxonomy ids as the group version).
    const muscleMax = new Map<string, number>()
    for (const m of set.muscles) {
      if (!acc.has(m.muscleId)) continue
      const w = roleWeight(m.role)
      if (w <= 0) continue
      const prev = muscleMax.get(m.muscleId) ?? 0
      if (w > prev) muscleMax.set(m.muscleId, w)
    }
    const setTonnage =
      set.reps != null && set.loadKg != null ? set.reps * set.loadKg : 0
    for (const [muscleId, w] of muscleMax) {
      const a = acc.get(muscleId)!
      a.weightedSets += w
      a.tonnageKg += setTonnage * w
    }
  }

  const groupSort = new Map(MUSCLE_GROUPS.map((g) => [g.id, g.sort]))
  return [...MUSCLES]
    .sort(
      (a, b) =>
        (groupSort.get(a.groupId) ?? 0) - (groupSort.get(b.groupId) ?? 0) || a.sort - b.sort,
    )
    .map((m) => ({
      muscleId: m.id,
      muscleName: m.name,
      groupId: m.groupId,
      weightedSets: acc.get(m.id)!.weightedSets,
      tonnageKg: acc.get(m.id)!.tonnageKg,
    }))
}

// --- weekly total volume (the Stats 8-week bar chart) -----------------

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// One working set with just what total tonnage needs — no muscle
// attribution, so the API can fetch these without the muscle join.
export interface WeeklySetInput {
  performedAtMs: number
  reps: number | null
  loadKg: number | null
}

export interface WeeklyVolume {
  from: string // ISO instant, bin start (inclusive)
  to: string // ISO instant, bin end (exclusive)
  tonnageKg: number
  sets: number
}

// Bucket working sets into fixed 7-day bins anchored at `fromMs`, oldest
// first, one entry per requested week (zeros for empty weeks). The caller
// supplies `fromMs` as a local-week boundary (its browser computes local
// Monday midnight, per the windowToRange convention), so this stays
// timezone-ignorant: bins are exact 7×24h spans of the anchor instant.
// Around a DST transition local midnight drifts up to an hour off the bin
// edge; a set logged inside that hour lands one bar over, which we accept
// for a coarse trend chart rather than shipping per-week boundary lists.
// Sets past the nominal end (the same DST hour) clamp into the last bin;
// sets before `fromMs` are ignored.
export function computeWeeklyVolume(
  sets: WeeklySetInput[],
  fromMs: number,
  weeks: number,
): WeeklyVolume[] {
  const out: WeeklyVolume[] = []
  for (let i = 0; i < weeks; i++) {
    out.push({
      from: new Date(fromMs + i * WEEK_MS).toISOString(),
      to: new Date(fromMs + (i + 1) * WEEK_MS).toISOString(),
      tonnageKg: 0,
      sets: 0,
    })
  }
  for (const s of sets) {
    if (s.performedAtMs < fromMs) continue
    const bin = Math.min(Math.floor((s.performedAtMs - fromMs) / WEEK_MS), weeks - 1)
    const w = out[bin]
    if (!w) continue
    w.sets += 1
    if (s.reps != null && s.loadKg != null) w.tonnageKg += s.reps * s.loadKg
  }
  return out
}

// --- personal records per exercise -----------------------------------

export interface PrSetInput {
  reps: number | null
  loadKg: number | null
  distanceM: number | null
  timeS: number | null
  performedAt: string // ISO
}

export interface ExercisePr {
  // Strength (load_reps): best estimated 1RM + the heaviest single load.
  bestE1rmKg: number | null
  bestE1rmAt: string | null
  heaviestLoadKg: number | null
  heaviestLoadAt: string | null
  // Endurance (distance_time): the longest single distance + the fastest
  // time over any set that recorded one.
  longestDistanceM: number | null
  fastestTimeS: number | null
}

const EMPTY_PR: ExercisePr = {
  bestE1rmKg: null,
  bestE1rmAt: null,
  heaviestLoadKg: null,
  heaviestLoadAt: null,
  longestDistanceM: null,
  fastestTimeS: null,
}

// --- exercise history (recent sets shown while logging) ---------------

// One flat working-set row for a single exercise, joined to its workout.
// The API gathers these (scoped to one user + exercise); grouping into
// sessions is the pure step below so it stays unit-tested.
export interface ExerciseHistorySetRow {
  workoutId: string
  workoutTitle: string | null
  performedAt: string // ISO
  setIndex: number
  reps: number | null
  loadKg: number | null
  rpe: number | null
}

export interface ExerciseHistorySet {
  reps: number | null
  loadKg: number | null
  rpe: number | null
}

// One past session's working sets for the exercise, newest session first.
export interface ExerciseHistorySession {
  workoutId: string
  workoutTitle: string | null
  performedAt: string // ISO
  sets: ExerciseHistorySet[]
}

// Group flat working-set rows (already scoped to one user + one exercise)
// into recent sessions: newest session first, capped at `sessionLimit`.
// Input rows may arrive in any order — sessions sort by performedAt desc,
// and sets sort by setIndex asc within each session. A non-positive
// sessionLimit returns every session.
export function groupExerciseHistory(
  rows: ExerciseHistorySetRow[],
  sessionLimit: number,
): ExerciseHistorySession[] {
  const byWorkout = new Map<string, { meta: ExerciseHistorySetRow; rows: ExerciseHistorySetRow[] }>()
  for (const r of rows) {
    const entry = byWorkout.get(r.workoutId)
    if (entry) entry.rows.push(r)
    else byWorkout.set(r.workoutId, { meta: r, rows: [r] })
  }
  const sessions = [...byWorkout.values()].sort((a, b) =>
    b.meta.performedAt.localeCompare(a.meta.performedAt),
  )
  const capped = sessionLimit > 0 ? sessions.slice(0, sessionLimit) : sessions
  return capped.map(({ meta, rows: setRows }) => ({
    workoutId: meta.workoutId,
    workoutTitle: meta.workoutTitle,
    performedAt: meta.performedAt,
    sets: setRows
      .slice()
      .sort((a, b) => a.setIndex - b.setIndex)
      .map((r) => ({ reps: r.reps, loadKg: r.loadKg, rpe: r.rpe })),
  }))
}

// Compute an exercise's PRs from all of a user's sets for it. Generic over
// modality: strength fields come from load/reps, endurance from
// distance/time; a row only updates the records its data supports.
export function computeExercisePr(sets: PrSetInput[]): ExercisePr {
  const pr: ExercisePr = { ...EMPTY_PR }
  for (const s of sets) {
    const e1rm = estimateOneRepMax(s.loadKg, s.reps)
    if (e1rm != null && (pr.bestE1rmKg == null || e1rm > pr.bestE1rmKg)) {
      pr.bestE1rmKg = e1rm
      pr.bestE1rmAt = s.performedAt
    }
    if (s.loadKg != null && s.loadKg > 0 && (pr.heaviestLoadKg == null || s.loadKg > pr.heaviestLoadKg)) {
      pr.heaviestLoadKg = s.loadKg
      pr.heaviestLoadAt = s.performedAt
    }
    if (s.distanceM != null && s.distanceM > 0 && (pr.longestDistanceM == null || s.distanceM > pr.longestDistanceM)) {
      pr.longestDistanceM = s.distanceM
    }
    if (s.timeS != null && s.timeS > 0 && (pr.fastestTimeS == null || s.timeS < pr.fastestTimeS)) {
      pr.fastestTimeS = s.timeS
    }
  }
  return pr
}
