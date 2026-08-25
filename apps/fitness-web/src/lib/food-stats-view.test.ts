import { describe, expect, it } from 'vitest'
import type { FoodDaySummaryDto } from '@rallypoint/fitness-shared'
import {
  buildCalorieDaySeries,
  calorieRangeDates,
  calorieStats,
  goalLineY,
  goalSparkDomain,
  sparklinePathWithDomain,
  statsRangeDays,
} from './food-stats-view.js'

function day(date: string, kcal: number, entries = 1): FoodDaySummaryDto {
  return { date, kcal, proteinG: 0, carbsG: 0, fatG: 0, entries }
}

describe('statsRangeDays / calorieRangeDates', () => {
  it('mirrors the training stats windows', () => {
    expect(statsRangeDays('7d')).toBe(7)
    expect(statsRangeDays('28d')).toBe(28)
    expect(statsRangeDays('year')).toBe(365)
  })
  it('spans count days ending today, inclusive', () => {
    const { start, end } = calorieRangeDates('7d', new Date(2026, 6, 17, 15, 0))
    expect(end).toBe('2026-07-17')
    expect(start).toBe('2026-07-11')
  })
  it('crosses month boundaries', () => {
    const { start } = calorieRangeDates('28d', new Date(2026, 6, 10))
    expect(start).toBe('2026-06-13')
  })
})

describe('buildCalorieDaySeries', () => {
  it('fills missing days with unlogged zeros, oldest first', () => {
    const series = buildCalorieDaySeries(
      [day('2026-07-15', 1800), day('2026-07-17', 2100)],
      '2026-07-17',
      4,
    )
    expect(series).toEqual([
      { date: '2026-07-14', kcal: 0, logged: false },
      { date: '2026-07-15', kcal: 1800, logged: true },
      { date: '2026-07-16', kcal: 0, logged: false },
      { date: '2026-07-17', kcal: 2100, logged: true },
    ])
  })
  it('ignores summary rows outside the window', () => {
    const series = buildCalorieDaySeries([day('2026-07-01', 900)], '2026-07-17', 3)
    expect(series.every((d) => !d.logged)).toBe(true)
  })
  it('treats a zero-entry row as unlogged', () => {
    const series = buildCalorieDaySeries([day('2026-07-17', 0, 0)], '2026-07-17', 1)
    expect(series[0]!.logged).toBe(false)
  })
})

describe('calorieStats', () => {
  const series = buildCalorieDaySeries(
    [day('2026-07-15', 1800), day('2026-07-16', 2300), day('2026-07-17', 2100)],
    '2026-07-17',
    7,
  )
  it('averages over logged days only', () => {
    const stats = calorieStats(series, null)
    expect(stats.loggedDays).toBe(3)
    expect(stats.avgKcal).toBe(Math.round((1800 + 2300 + 2100) / 3))
    expect(stats.onTargetDays).toBeNull()
  })
  it('counts logged days at or under the goal', () => {
    expect(calorieStats(series, 2100).onTargetDays).toBe(2)
    expect(calorieStats(series, 1000).onTargetDays).toBe(0)
  })
  it('handles an empty window without dividing by zero', () => {
    const stats = calorieStats(buildCalorieDaySeries([], '2026-07-17', 7), 2000)
    expect(stats.avgKcal).toBe(0)
    expect(stats.loggedDays).toBe(0)
    expect(stats.onTargetDays).toBe(0)
  })
})

describe('goalSparkDomain / goalLineY / sparklinePathWithDomain', () => {
  it('extends the domain to keep the goal in-frame', () => {
    expect(goalSparkDomain([1800, 2200], 2500)).toEqual({ min: 1800, max: 2500 })
    expect(goalSparkDomain([1800, 2200], null)).toEqual({ min: 1800, max: 2200 })
    expect(goalSparkDomain([], null)).toEqual({ min: 0, max: 1 })
  })
  it('projects the goal onto the same scale as the path', () => {
    const domain = { min: 0, max: 2000 }
    // Goal at the max → the top pad line; at the min → bottom.
    expect(goalLineY(domain, 2000, 64)).toBe(2)
    expect(goalLineY(domain, 0, 64)).toBe(62)
    expect(goalLineY(domain, 1000, 64)).toBe(32)
  })
  it('builds a path only with 2+ points and closes the area to the base', () => {
    expect(sparklinePathWithDomain([5], { min: 0, max: 10 }, 320, 64)).toEqual({
      line: '',
      area: '',
    })
    const { line, area } = sparklinePathWithDomain([0, 10], { min: 0, max: 10 }, 320, 64)
    expect(line).toBe('M2.0,62.0 L318.0,2.0')
    expect(area).toContain('Z')
  })
})
