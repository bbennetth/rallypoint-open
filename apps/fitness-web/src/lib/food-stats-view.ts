// Pure helpers for the /stats Food (calorie dashboard) view. The React
// layer owns fetching + rendering; everything decision-shaped lives
// here so it's unit-testable: filling the day series (the summary
// endpoint omits empty days), the actual-vs-goal aggregate tiles, and
// the goal-line projection for the year sparkline.

import type { FoodDaySummaryDto } from '@rallypoint/fitness-shared'
import { localDateStr, shiftDay } from './food-view.js'
import type { StatsRange } from './stats-view.js'

/** Days covered by a stats range — mirrors statsRangeToDates. */
export function statsRangeDays(range: StatsRange): number {
  return range === '7d' ? 7 : range === '28d' ? 28 : 365
}

export interface CalorieDay {
  /** Local 'YYYY-MM-DD'. */
  date: string
  kcal: number
  /** False when nothing was logged that day (kcal is 0 by fill). */
  logged: boolean
}

/** Expand the sparse summary rows into a dense oldest→newest series of
 *  `count` days ending on `endDate` (local 'YYYY-MM-DD', normally
 *  today). Missing days fill as unlogged zeros so bars/sparklines keep
 *  a stable x-axis. */
export function buildCalorieDaySeries(
  days: readonly FoodDaySummaryDto[],
  endDate: string,
  count: number,
): CalorieDay[] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const out: CalorieDay[] = []
  for (let i = count - 1; i >= 0; i--) {
    const date = shiftDay(endDate, -i)
    const row = byDate.get(date)
    out.push(
      row && row.entries > 0
        ? { date, kcal: row.kcal, logged: true }
        : { date, kcal: 0, logged: false },
    )
  }
  return out
}

export interface CalorieStats {
  /** Days in the window with at least one entry. */
  loggedDays: number
  /** Mean kcal across logged days only (0 when none). */
  avgKcal: number
  /** Logged days at or under the goal. Null when no goal is set. */
  onTargetDays: number | null
}

/** Aggregate the series into the top-of-page stat tiles. Averaging over
 *  logged days only — an untracked day is missing data, not a 0 kcal
 *  day, and counting it would flatter the average. */
export function calorieStats(
  series: readonly CalorieDay[],
  goal: number | null,
): CalorieStats {
  const logged = series.filter((d) => d.logged)
  const total = logged.reduce((sum, d) => sum + d.kcal, 0)
  return {
    loggedDays: logged.length,
    avgKcal: logged.length > 0 ? Math.round(total / logged.length) : 0,
    onTargetDays: goal === null ? null : logged.filter((d) => d.kcal <= goal).length,
  }
}

/** The [from, to] local dates a range covers, ending today. */
export function calorieRangeDates(range: StatsRange, now: Date): { start: string; end: string } {
  const end = localDateStr(now)
  return { start: shiftDay(end, -(statsRangeDays(range) - 1)), end }
}

/** Like stats-view's sparklinePath, but with an explicit y-domain so a
 *  goal line drawn with goalLineY shares the exact projection (the
 *  bodyweight sparkline derives its domain from the values alone, which
 *  would clip a goal outside the logged range). */
export function sparklinePathWithDomain(
  values: readonly number[],
  domain: { min: number; max: number },
  viewW: number,
  viewH: number,
  pad = 2,
): { line: string; area: string } {
  if (values.length < 2) return { line: '', area: '' }
  const range = domain.max - domain.min || 1
  const points = values.map((v, i) => ({
    x: pad + (i / (values.length - 1)) * (viewW - pad * 2),
    y: pad + (1 - (v - domain.min) / range) * (viewH - pad * 2),
  }))
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ')
  const first = points[0]!
  const last = points[points.length - 1]!
  const area = `${line} L${last.x.toFixed(1)},${viewH} L${first.x.toFixed(1)},${viewH} Z`
  return { line, area }
}

/** Y coordinate for a horizontal goal line over a sparkline built by
 *  sparklinePathWithDomain — same projection, with the goal included in
 *  the domain (via goalSparkDomain) so the line always lands in-frame. */
export function goalLineY(
  domain: { min: number; max: number },
  goal: number,
  viewH: number,
  pad = 2,
): number {
  const range = domain.max - domain.min || 1
  return pad + (1 - (goal - domain.min) / range) * (viewH - pad * 2)
}

/** Min/max domain for the year sparkline: the kcal values plus the goal
 *  (when set) so the goal line never clips outside the viewBox. */
export function goalSparkDomain(
  values: readonly number[],
  goal: number | null,
): { min: number; max: number } {
  const all = goal === null ? [...values] : [...values, goal]
  if (all.length === 0) return { min: 0, max: 1 }
  return { min: Math.min(...all), max: Math.max(...all) }
}
