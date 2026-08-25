import { describe, it, expect } from 'vitest'
import {
  aggregateTrainingStats,
  bestStreakDays,
  formatTonnage,
  formatTrainingTime,
  sparklinePath,
  splitTonnage,
  statsRangeToDates,
} from './stats-view.js'
import type { WorkoutDto } from './api.js'

function w(
  modality: string,
  durationS: number | null,
  sets: { reps?: number; loadKg?: number; setType?: 'warmup' | 'working' }[] = [],
): WorkoutDto {
  const fullSets = sets.map((s, i) => ({
    id: `s${i}`,
    exerciseId: 'fx',
    setIndex: i,
    reps: s.reps ?? null,
    loadKg: s.loadKg ?? null,
    distanceM: null,
    timeS: null,
    rounds: null,
    rpe: null,
    notes: null,
    setType: s.setType ?? 'working',
  }))
  return { modality, durationS, sets: fullSets } as unknown as WorkoutDto
}

describe('statsRangeToDates', () => {
  const now = new Date('2026-06-25T12:00:00Z')
  it('returns a 7-day window for 7d', () => {
    const { from, to } = statsRangeToDates('7d', now)
    expect(to).toBe('2026-06-25T12:00:00.000Z')
    expect(from).toBe('2026-06-18T12:00:00.000Z')
  })
  it('returns a 28-day window for 28d', () => {
    const { from } = statsRangeToDates('28d', now)
    expect(from).toBe('2026-05-28T12:00:00.000Z')
  })
  it('returns a 365-day window for year', () => {
    const { from } = statsRangeToDates('year', now)
    expect(from).toBe('2025-06-25T12:00:00.000Z')
  })
})

describe('aggregateTrainingStats', () => {
  it('returns zeroed-out stats for empty input', () => {
    expect(aggregateTrainingStats([])).toEqual({
      sessions: 0,
      tonnageKg: 0,
      timeS: 0,
      avgSessionS: 0,
      modalitySplit: [],
    })
  })
  it('sums tonnage from reps × loadKg across all sets', () => {
    const s = aggregateTrainingStats([
      w('strength', 1800, [{ reps: 5, loadKg: 100 }, { reps: 5, loadKg: 100 }]),
      w('strength', 1500, [{ reps: 8, loadKg: 80 }]),
    ])
    expect(s.tonnageKg).toBe(5 * 100 + 5 * 100 + 8 * 80)
    expect(s.sessions).toBe(2)
    expect(s.timeS).toBe(3300)
  })
  it('excludes warmup sets from tonnage', () => {
    const s = aggregateTrainingStats([
      w('strength', 1800, [
        { reps: 5, loadKg: 40, setType: 'warmup' },
        { reps: 5, loadKg: 100 },
      ]),
    ])
    expect(s.tonnageKg).toBe(5 * 100)
  })
  it('ignores workouts with null durationS in the time tally', () => {
    const s = aggregateTrainingStats([
      w('strength', 1800, [{ reps: 5, loadKg: 100 }]),
      w('strength', null, [{ reps: 5, loadKg: 100 }]),
    ])
    expect(s.timeS).toBe(1800)
    expect(s.sessions).toBe(2)
  })
  it('computes modality split as percentages summing to 100', () => {
    const s = aggregateTrainingStats([
      w('strength', null),
      w('strength', null),
      w('conditioning', null),
      w('endurance', null),
    ])
    const pcts = s.modalitySplit.map((r) => r.pct)
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(100)
    expect(s.modalitySplit.find((r) => r.modality === 'strength')?.sessions).toBe(2)
  })
  it('excludes modalities with zero sessions from the split', () => {
    const s = aggregateTrainingStats([w('strength', null), w('strength', null)])
    expect(s.modalitySplit).toHaveLength(1)
  })
})

describe('aggregateTrainingStats avgSessionS', () => {
  it('averages only over workouts that recorded a duration', () => {
    const s = aggregateTrainingStats([
      w('strength', 1800),
      w('strength', 3600),
      w('strength', null),
    ])
    expect(s.timeS).toBe(5400)
    expect(s.avgSessionS).toBe(2700)
  })

  it('is 0 when no workout recorded a duration', () => {
    const s = aggregateTrainingStats([w('strength', null), w('wod', null)])
    expect(s.avgSessionS).toBe(0)
  })
})

describe('bestStreakDays', () => {
  // Local-noon instants so the local calendar date is unambiguous in any
  // test-runner timezone.
  function at(y: number, m: number, d: number): WorkoutDto {
    return {
      ...w('strength', null),
      performedAt: new Date(y, m, d, 12, 0).toISOString(),
    } as WorkoutDto
  }

  it('returns 0 for no workouts and 1 for a single day', () => {
    expect(bestStreakDays([])).toBe(0)
    expect(bestStreakDays([at(2026, 5, 10)])).toBe(1)
  })

  it('counts consecutive days and lets a gap break the run', () => {
    const streak = bestStreakDays([
      at(2026, 5, 8),
      at(2026, 5, 9),
      at(2026, 5, 10),
      // gap on the 11th
      at(2026, 5, 12),
      at(2026, 5, 13),
    ])
    expect(streak).toBe(3)
  })

  it('keeps the best earlier run when a later run is shorter', () => {
    const streak = bestStreakDays([
      at(2026, 4, 1),
      at(2026, 4, 2),
      at(2026, 4, 3),
      at(2026, 4, 4),
      at(2026, 4, 20),
      at(2026, 4, 21),
    ])
    expect(streak).toBe(4)
  })

  it('counts multiple workouts on one day once', () => {
    const streak = bestStreakDays([
      at(2026, 5, 9),
      at(2026, 5, 9),
      at(2026, 5, 10),
    ])
    expect(streak).toBe(2)
  })

  it('runs across a month boundary', () => {
    const streak = bestStreakDays([
      at(2026, 4, 30),
      at(2026, 4, 31),
      at(2026, 5, 1),
    ])
    expect(streak).toBe(3)
  })

  it('is order-independent', () => {
    const streak = bestStreakDays([
      at(2026, 5, 10),
      at(2026, 5, 8),
      at(2026, 5, 9),
    ])
    expect(streak).toBe(3)
  })
})

describe('splitTonnage', () => {
  it('splits every formatTonnage shape into value + unit', () => {
    expect(splitTonnage('850 kg')).toEqual({ value: '850', unit: 'kg' })
    expect(splitTonnage('1.2 t')).toEqual({ value: '1.2', unit: 't' })
    expect(splitTonnage('49.6k lb')).toEqual({ value: '49.6k', unit: 'lb' })
    expect(splitTonnage('8,500 lb')).toEqual({ value: '8,500', unit: 'lb' })
  })

  it('keeps the whole string as the value when there is no unit', () => {
    expect(splitTonnage('0')).toEqual({ value: '0', unit: '' })
    expect(splitTonnage('')).toEqual({ value: '', unit: '' })
  })
})

describe('formatTonnage', () => {
  it('formats sub-1000kg as "Xkg" (rounded)', () => {
    expect(formatTonnage(0)).toBe('0 kg')
    expect(formatTonnage(123.4)).toBe('123 kg')
    expect(formatTonnage(999)).toBe('999 kg')
  })
  it('formats >=1000kg as "X.Y t"', () => {
    expect(formatTonnage(1000)).toBe('1.0 t')
    expect(formatTonnage(2350)).toBe('2.4 t')
  })
})

describe('formatTrainingTime', () => {
  it('formats sub-hour as "X min"', () => {
    expect(formatTrainingTime(0)).toBe('0 min')
    expect(formatTrainingTime(45 * 60)).toBe('45 min')
  })
  it('formats hour+ as "X.Y h"', () => {
    expect(formatTrainingTime(3600)).toBe('1.0 h')
    expect(formatTrainingTime(2.5 * 3600)).toBe('2.5 h')
  })
})

describe('sparklinePath', () => {
  it('returns empty paths for <2 points', () => {
    expect(sparklinePath([], 320, 64)).toEqual({ line: '', area: '', points: [] })
    expect(sparklinePath([5], 320, 64).line).toBe('')
  })
  it('produces a polyline d-attribute for the line and a closed area path', () => {
    const out = sparklinePath([1, 2, 3], 100, 50)
    expect(out.line.startsWith('M')).toBe(true)
    expect(out.line.includes('L')).toBe(true)
    expect(out.area.endsWith(' Z')).toBe(true)
    expect(out.points).toHaveLength(3)
  })
  it('normalizes all-equal values without dividing by zero', () => {
    const out = sparklinePath([10, 10, 10], 100, 50)
    expect(out.line).not.toContain('NaN')
    expect(out.points.every((p) => Number.isFinite(p.y))).toBe(true)
  })
})
