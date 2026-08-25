// Pure view-layer helpers for the Stats › Training insights surface
// (TrainingView). No React deps. All inputs/outputs are plain data —
// testable without a DOM or network.

import type { MuscleGroupVolume, ExercisePr, WeeklyVolume } from '@rallypoint/fitness-shared'
import { formatLoad, formatTonnage as formatTonnageUnit } from './units.js'
import type { WeightUnit } from './units.js'

// ---------------------------------------------------------------------------
// Window → ISO date range
// ---------------------------------------------------------------------------

export type InsightWindow = 7 | 30 | 90

/**
 * Compute the ISO instant pair for a trailing window of `days` calendar days
 * in the user's LOCAL timezone, relative to a reference instant (defaults to
 * now). Returns `[from, to)` as a half-open window where:
 *  - `from` = local midnight of `today - days`
 *  - `to`   = local midnight of `today + 1` (exclusive upper bound — picks up
 *            every workout performed today regardless of when "now" is)
 *
 * Per `[[planner-timezone-boundary]]`, the client owns "today"; the API just
 * runs the date-range filter on UTC instants. Previously this returned
 * UTC-midnight date-only strings, which shifted the window forward by a day
 * for a user in UTC-7 browsing at 23:30 local.
 */
export function windowToRange(days: InsightWindow, now: Date = new Date()): { from: string; to: string } {
  const localMidnightToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const fromDate = new Date(localMidnightToday)
  fromDate.setDate(fromDate.getDate() - days)
  const toDate = new Date(localMidnightToday)
  toDate.setDate(toDate.getDate() + 1)
  return { from: fromDate.toISOString(), to: toDate.toISOString() }
}

/**
 * The window for the Stats weekly-volume chart: local Monday midnight
 * `weeks` weeks back → next local Monday midnight, half-open, as UTC ISO
 * instants. Same client-owns-local-boundaries model as windowToRange; the
 * server buckets into fixed 7-day bins anchored at `from`, so anchoring
 * on the user's local week start is what makes the bars mean "my weeks".
 * Date arithmetic via setDate so DST transitions keep midnight boundaries.
 */
export function weeklyVolumeRange(
  weeks = 8,
  now: Date = new Date(),
): { from: string; to: string } {
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // Monday of the current local week (getDay(): Sun=0 … Sat=6).
  const monday = new Date(localMidnight)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const fromDate = new Date(monday)
  fromDate.setDate(fromDate.getDate() - (weeks - 1) * 7)
  const toDate = new Date(monday)
  toDate.setDate(toDate.getDate() + 7)
  return { from: fromDate.toISOString(), to: toDate.toISOString() }
}

// ---------------------------------------------------------------------------
// Weekly-volume chart bars
// ---------------------------------------------------------------------------

export interface WeeklyBarVm {
  /** Column label, 'W1' … 'W8' oldest-first. */
  label: string
  /** CSS height string, '0%'–'100%'; the biggest week reaches 100%. */
  heightPct: string
  /** True only for the last (current) week — the accented bar. */
  current: boolean
  tonnageKg: number
}

/**
 * Scale the API's weekly bins into chart bars. All-zero input yields all
 * '0%' (the CSS min-height stub keeps a visible baseline), never NaN.
 */
export function buildWeeklyBarVms(weeks: WeeklyVolume[]): WeeklyBarVm[] {
  const max = Math.max(0, ...weeks.map((w) => w.tonnageKg))
  return weeks.map((w, i) => ({
    label: `W${i + 1}`,
    heightPct: `${max > 0 ? Math.round((w.tonnageKg / max) * 100) : 0}%`,
    current: i === weeks.length - 1,
    tonnageKg: w.tonnageKg,
  }))
}

// ---------------------------------------------------------------------------
// Volume bar scaling
// ---------------------------------------------------------------------------

export interface VolumeBarVm {
  groupId: string
  groupName: string
  weightedSets: number
  tonnageKg: number
  /** Bar fill fraction 0–1 (max group = 1). */
  barFraction: number
  /** CSS percentage width string, e.g. "73%". */
  barWidthPct: string
}

/**
 * Given the API's group list, produce a view-model with bar fractions
 * scaled so the highest-volume group reaches 100%.
 * Groups are returned in taxonomy order (as the API delivers them).
 * Groups with zero weighted sets are included but their bar is 0.
 */
export function buildVolumeBarVms(groups: MuscleGroupVolume[]): VolumeBarVm[] {
  const maxSets = Math.max(0, ...groups.map((g) => g.weightedSets))
  return groups.map((g) => {
    const barFraction = maxSets > 0 ? g.weightedSets / maxSets : 0
    return {
      groupId: g.groupId,
      groupName: g.groupName,
      weightedSets: g.weightedSets,
      tonnageKg: g.tonnageKg,
      barFraction,
      barWidthPct: `${Math.round(barFraction * 100)}%`,
    }
  })
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Format a tonnage value: <1000 kg → "NNN kg", ≥1000 → "N.Nt" (tonnes).
 * `unit` defaults to 'kg' so existing (untouched) call sites keep the
 * exact legacy string shape; a caller passing 'lb' delegates to
 * units.ts's unit-aware formatter. Storage stays kg regardless — this
 * only decides the display string.
 */
export function formatTonnage(kg: number, unit: WeightUnit = 'kg'): string {
  if (unit === 'lb') return formatTonnageUnit(kg, unit)
  if (kg <= 0) return '0 kg'
  if (kg < 1000) return `${Math.round(kg)} kg`
  return `${(kg / 1000).toFixed(1)}t`
}

/**
 * Format a weight in kg with 1 decimal place.
 * e.g. 102.5 → "102.5 kg"
 * `unit` defaults to 'kg' to preserve the legacy 1dp-kg shape; a
 * caller passing 'lb' converts to the display unit via units.ts
 * (stored kg -> display unit; storage stays kg).
 */
export function formatWeightKg(kg: number, unit: WeightUnit = 'kg'): string {
  if (unit === 'lb') return formatLoad(kg, unit)
  return `${kg % 1 === 0 ? kg.toFixed(0) : kg.toFixed(1)} kg`
}

/**
 * Format a distance in metres: <1000 m → "NNN m", ≥1000 → "N.Nkm".
 */
export function formatDistanceM(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`
  return `${(m / 1000).toFixed(2).replace(/\.?0+$/, '')}km`
}

/**
 * Format a time in seconds as mm:ss (or h:mm:ss for ≥1 hour).
 */
export function formatTimeS(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`
  return `${pad(m)}:${pad(sec)}`
}

/**
 * Format a weighted-sets value with 1 decimal if fractional, integer otherwise.
 */
export function formatSets(n: number): string {
  if (n <= 0) return '0'
  const rounded = Math.round(n * 10) / 10
  return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1)
}

// Cached UTC formatter so we don't rebuild it per call (`formatPrDate` is
// invoked once per PR row on every insights render).
const PR_MONTH_FMT = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' })

/**
 * Format a short ISO date string (YYYY-MM-DD or full ISO) as a readable date.
 * e.g. "2026-06-20" → "20 Jun 2026"
 *
 * All date parts read in UTC so the rendered string is stable across
 * timezones — PR dates are calendar dates, not instants, and a PR set
 * shouldn't appear to shift one day forward/back depending on where the
 * page is loaded.
 */
export function formatPrDate(iso: string): string {
  const d = new Date(iso)
  const day = d.getUTCDate()
  const mon = PR_MONTH_FMT.format(d)
  const year = d.getUTCFullYear()
  return `${day} ${mon} ${year}`
}

// ---------------------------------------------------------------------------
// PR row view-model
// ---------------------------------------------------------------------------

/** The four possible record types, used to decide which cells to show. */
export interface PrRowVm {
  exerciseId: string
  exerciseName: string
  // Strength fields (null = this exercise has no strength records)
  bestE1rmDisplay: string | null
  bestE1rmDateDisplay: string | null
  heaviestLoadDisplay: string | null
  heaviestLoadDateDisplay: string | null
  // Endurance fields (null = no endurance records)
  longestDistanceDisplay: string | null
  fastestTimeDisplay: string | null
  // Type category for sorting/grouping
  category: 'strength' | 'endurance' | 'mixed'
}

/**
 * Turn the API's PR list into a flat display-ready row view-model.
 * Strength PRs (those with e1rm or load) are sorted first, then
 * endurance-only, then mixed. Within each group, sort by exercise name.
 */
export function buildPrRowVms(
  exercises: Array<{ exerciseId: string; exerciseName: string } & ExercisePr>,
  unit: WeightUnit = 'kg',
): PrRowVm[] {
  const rows: PrRowVm[] = exercises.map((ex) => {
    const hasStrength = ex.bestE1rmKg != null || ex.heaviestLoadKg != null
    const hasEndurance = ex.longestDistanceM != null || ex.fastestTimeS != null
    const category: PrRowVm['category'] =
      hasStrength && hasEndurance ? 'mixed' : hasStrength ? 'strength' : 'endurance'

    return {
      exerciseId: ex.exerciseId,
      exerciseName: ex.exerciseName,
      bestE1rmDisplay: ex.bestE1rmKg != null ? formatWeightKg(ex.bestE1rmKg, unit) : null,
      bestE1rmDateDisplay: ex.bestE1rmAt != null ? formatPrDate(ex.bestE1rmAt) : null,
      heaviestLoadDisplay: ex.heaviestLoadKg != null ? formatWeightKg(ex.heaviestLoadKg, unit) : null,
      heaviestLoadDateDisplay: ex.heaviestLoadAt != null ? formatPrDate(ex.heaviestLoadAt) : null,
      longestDistanceDisplay: ex.longestDistanceM != null ? formatDistanceM(ex.longestDistanceM) : null,
      fastestTimeDisplay: ex.fastestTimeS != null ? formatTimeS(ex.fastestTimeS) : null,
      category,
    }
  })

  // Sort: strength first, then mixed, then endurance-only; alpha within each.
  const rank = { strength: 0, mixed: 1, endurance: 2 } as const
  rows.sort((a, b) => {
    const catDiff = rank[a.category] - rank[b.category]
    if (catDiff !== 0) return catDiff
    return a.exerciseName.localeCompare(b.exerciseName)
  })

  return rows
}
