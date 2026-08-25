// Pure helpers for the redesigned /stats Training view. The design
// handoff swapped the prior 7/30/90-day window for a 7-day / 28-day /
// year segmented control and added 3 top-level stat tiles (sessions,
// tonnage, training time) plus a modality-split bar. These helpers
// are unit-testable in isolation; the React layer only owns
// fetching + rendering.

import { MODALITIES, summarizeWorkoutSets } from '@rallypoint/fitness-shared'
import type { Modality } from '@rallypoint/fitness-shared'
import type { WorkoutDto } from './api.js'
import { formatTonnage as formatTonnageUnit } from './units.js'
import type { WeightUnit } from './units.js'

/** Allowed ranges for the redesigned Training tab. `year` = trailing
 *  365 days; per the handoff the segmented control labels them
 *  `7 DAYS / 28 DAYS / YEAR`. */
export type StatsRange = '7d' | '28d' | 'year'

export const STATS_RANGES: { value: StatsRange; label: string }[] = [
  { value: '7d', label: '7 Days' },
  { value: '28d', label: '28 Days' },
  { value: 'year', label: 'Year' },
]

/** Half-open `[from, to)` ISO instant range for a stats window. The
 *  caller supplies `now` so tests are deterministic. */
export function statsRangeToDates(
  range: StatsRange,
  now: Date,
): { from: string; to: string } {
  const days = range === '7d' ? 7 : range === '28d' ? 28 : 365
  const to = new Date(now)
  const from = new Date(now)
  from.setDate(from.getDate() - days)
  return { from: from.toISOString(), to: to.toISOString() }
}

export interface TrainingStats {
  /** Total logged sessions in the window. */
  sessions: number
  /** Total tonnage (kg) lifted across all sets. */
  tonnageKg: number
  /** Total recorded training time (seconds). Excludes workouts with
   *  unrecorded duration (durationS == null). */
  timeS: number
  /** Mean session length (seconds) over workouts that recorded a
   *  duration; 0 when none did. Powers the "Avg session" tile. */
  avgSessionS: number
  /** Modality split as a percentage of total sessions, ordered by the
   *  canonical MODALITIES enum so the legend stays stable across
   *  renders. Sums to 100 (with rounding tolerance). */
  modalitySplit: { modality: Modality; sessions: number; pct: number }[]
}

/** Aggregate a flat workout list into the top-of-page stat tiles + the
 *  modality split bar. The caller supplies the pre-filtered window. */
export function aggregateTrainingStats(workouts: readonly WorkoutDto[]): TrainingStats {
  let tonnageKg = 0
  let timeS = 0
  let timedSessions = 0
  const byModality = new Map<Modality, number>()
  for (const w of workouts) {
    // Warmup sets never count toward tonnage.
    const s = summarizeWorkoutSets(w.sets.filter((set) => set.setType !== 'warmup'))
    tonnageKg += s.tonnageKg
    if (typeof w.durationS === 'number') {
      timeS += w.durationS
      timedSessions += 1
    }
    if ((MODALITIES as readonly string[]).includes(w.modality)) {
      const m = w.modality as Modality
      byModality.set(m, (byModality.get(m) ?? 0) + 1)
    }
  }
  const total = workouts.length
  const modalitySplit = MODALITIES.map((m) => {
    const sessions = byModality.get(m) ?? 0
    const pct = total > 0 ? Math.round((sessions / total) * 100) : 0
    return { modality: m, sessions, pct }
  }).filter((row) => row.sessions > 0)
  return {
    sessions: total,
    tonnageKg,
    timeS,
    avgSessionS: timedSessions > 0 ? timeS / timedSessions : 0,
    modalitySplit,
  }
}

/** Longest run of consecutive local calendar days with at least one
 *  workout — the "Best streak" tile. Multiple workouts on one day count
 *  once; the local date key follows the same client-owns-local-days
 *  model as the range helpers. */
export function bestStreakDays(workouts: readonly WorkoutDto[]): number {
  // Dedupe to local midnights (multiple workouts a day count once)…
  const midnights = new Map<number, Date>()
  for (const w of workouts) {
    const d = new Date(w.performedAt)
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    midnights.set(midnight.getTime(), midnight)
  }
  // …then test adjacency with calendar arithmetic (setDate), not fixed
  // 24h spans, so 23/25-hour DST days still read as consecutive.
  const days = [...midnights.values()].sort((a, b) => a.getTime() - b.getTime())
  let best = 0
  let run = 0
  let prev: Date | null = null
  for (const day of days) {
    if (prev != null) {
      const next = new Date(prev)
      next.setDate(next.getDate() + 1)
      run = next.getTime() === day.getTime() ? run + 1 : 1
    } else {
      run = 1
    }
    if (run > best) best = run
    prev = day
  }
  return best
}

/** Format kg as either `1.2 t` (when >=1000) or `850 kg`. Delegates to
 *  units.ts's unit-aware formatter; storage stays kg, this only picks
 *  the display unit. Defaults to 'kg' so untouched call sites still
 *  behave the way they did before the lb/kg preference existed. */
export function formatTonnage(kg: number, unit: WeightUnit = 'kg'): string {
  if (kg <= 0) return unit === 'lb' ? '0 lb' : '0 kg'
  return formatTonnageUnit(kg, unit)
}

/** Split a formatted tonnage into its numeric head and unit tail, so a
 *  stat tile can put them in the frame's `.v` / `.u` slots instead of
 *  wrapping "49.6k lb" across two lines in a narrow column. Every
 *  formatTonnage shape is `<number> <unit>` with one space, so the last
 *  space is the split point; an unexpected shape degrades to an empty
 *  unit rather than losing text. */
export function splitTonnage(formatted: string): { value: string; unit: string } {
  const i = formatted.lastIndexOf(' ')
  if (i <= 0) return { value: formatted, unit: '' }
  return { value: formatted.slice(0, i), unit: formatted.slice(i + 1) }
}

/** Format seconds as `4.5 h` or `38 min` when sub-hour. */
export function formatTrainingTime(s: number): string {
  if (s <= 0) return '0 min'
  const h = s / 3600
  if (h >= 1) return `${h.toFixed(1)} h`
  return `${Math.round(s / 60)} min`
}

// ── Bodyweight sparkline ──────────────────────────────────────────────────────

export interface SparkPoint {
  x: number
  y: number
}

/** Project a series of {value} samples (oldest→newest) into SVG path
 *  coordinates fitting `viewW x viewH`. Returns the polyline path-d
 *  plus a closed-area path (for the soft fill behind the line). When
 *  the series has 0–1 points the d-strings are empty (renderer draws a
 *  dashed midline instead). */
export function sparklinePath(
  values: readonly number[],
  viewW: number,
  viewH: number,
  pad = 2,
): { line: string; area: string; points: SparkPoint[] } {
  if (values.length < 2) return { line: '', area: '', points: [] }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const points = values.map((v, i) => ({
    x: pad + (i / (values.length - 1)) * (viewW - pad * 2),
    y: pad + (1 - (v - min) / range) * (viewH - pad * 2),
  }))
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ')
  const first = points[0]!
  const last = points[points.length - 1]!
  const area = `${line} L${last.x.toFixed(1)},${viewH} L${first.x.toFixed(1)},${viewH} Z`
  return { line, area, points }
}
