// Unit tests for insights-view pure helpers. No DOM, no React, no network.
import { describe, it, expect } from 'vitest'
import {
  windowToRange,
  weeklyVolumeRange,
  buildWeeklyBarVms,
  buildVolumeBarVms,
  formatTonnage,
  formatWeightKg,
  formatDistanceM,
  formatTimeS,
  formatSets,
  formatPrDate,
  buildPrRowVms,
} from './insights-view.js'
import type { WeeklyVolume } from '@rallypoint/fitness-shared'

// ── windowToRange ─────────────────────────────────────────────────────────────

describe('windowToRange', () => {
  // Use a local-time reference so the local-midnight math is deterministic
  // regardless of the test runner's timezone (UTC midnight rounds the wrong
  // way for any user east of UTC). Build the ref from local Y/M/D directly.
  const refLocal = (y: number, m: number, d: number, h = 12): Date => new Date(y, m - 1, d, h, 0, 0, 0)

  // The local-midnight boundary as an ISO instant, derived the same way the
  // function under test derives it, so the expectations are TZ-agnostic.
  const localMidnight = (y: number, m: number, d: number): string =>
    new Date(y, m - 1, d).toISOString()

  it('`to` is local midnight of tomorrow (half-open upper bound)', () => {
    const ref = refLocal(2026, 6, 26)
    const { to } = windowToRange(7, ref)
    expect(to).toBe(localMidnight(2026, 6, 27))
  })

  it('7-day window: from is local midnight 7 days before today', () => {
    const ref = refLocal(2026, 6, 26)
    const { from } = windowToRange(7, ref)
    expect(from).toBe(localMidnight(2026, 6, 19))
  })

  it('30-day window: from is local midnight 30 days before today', () => {
    const ref = refLocal(2026, 6, 26)
    const { from } = windowToRange(30, ref)
    expect(from).toBe(localMidnight(2026, 5, 27))
  })

  it('90-day window: from is local midnight 90 days before today', () => {
    const ref = refLocal(2026, 6, 26)
    const { from } = windowToRange(90, ref)
    expect(from).toBe(localMidnight(2026, 3, 28))
  })

  it("late-evening local user doesn't shift the window forward by a day", () => {
    // Regression: previously windowToRange used UTC date parts. A PDT user
    // (UTC-7) at 23:30 local on June 26 saw `to` come back as June 27
    // because `new Date().toISOString()` was already the next UTC day.
    // With local-day math, the `to` boundary is local midnight of June 27.
    const ref = refLocal(2026, 6, 26, 23) // 23:00 local
    const { from, to } = windowToRange(7, ref)
    expect(from).toBe(localMidnight(2026, 6, 19))
    expect(to).toBe(localMidnight(2026, 6, 27))
  })
})

// ── buildVolumeBarVms ─────────────────────────────────────────────────────────

// ── weeklyVolumeRange ────────────────────────────────────────────────────────

describe('weeklyVolumeRange', () => {
  // Local-time refs, same rationale as the windowToRange tests above.
  const wednesday = new Date(2026, 5, 24, 15, 30) // Wed 2026-06-24 local
  const monday = new Date(2026, 5, 22, 0, 0) // Mon 2026-06-22 local midnight

  it('anchors from at local Monday midnight 8 weeks back, to at next Monday', () => {
    const { from, to } = weeklyVolumeRange(8, wednesday)
    // Current week starts Mon 2026-06-22; 7 weeks before that is Mon 2026-05-04.
    expect(new Date(from).getTime()).toBe(new Date(2026, 4, 4).getTime())
    expect(new Date(to).getTime()).toBe(new Date(2026, 5, 29).getTime())
  })

  it('treats a Monday reference as its own week start', () => {
    const { from, to } = weeklyVolumeRange(2, monday)
    expect(new Date(from).getTime()).toBe(new Date(2026, 5, 15).getTime())
    expect(new Date(to).getTime()).toBe(new Date(2026, 5, 29).getTime())
  })

  it('treats a Sunday as the tail of the week started the previous Monday', () => {
    const sunday = new Date(2026, 5, 28, 23, 59)
    const { from, to } = weeklyVolumeRange(2, sunday)
    expect(new Date(from).getTime()).toBe(new Date(2026, 5, 15).getTime())
    expect(new Date(to).getTime()).toBe(new Date(2026, 5, 29).getTime())
  })

  it('crosses a year boundary cleanly', () => {
    const early = new Date(2026, 0, 7, 9, 0) // Wed 2026-01-07; week starts Mon Jan 5
    const { from } = weeklyVolumeRange(8, early)
    // 7 weeks before Mon 2026-01-05 = Mon 2025-11-17.
    expect(new Date(from).getTime()).toBe(new Date(2025, 10, 17).getTime())
  })

  it('spans exactly `weeks` calendar weeks', () => {
    const { from, to } = weeklyVolumeRange(8, wednesday)
    const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000
    // 56 exactly outside DST transitions; setDate keeps midnight anchors
    // either way, so the day count is always a whole number of days.
    expect(Math.round(days)).toBe(56)
  })
})

// ── buildWeeklyBarVms ────────────────────────────────────────────────────────

function week(tonnageKg: number): WeeklyVolume {
  return { from: '2026-06-01T00:00:00.000Z', to: '2026-06-08T00:00:00.000Z', tonnageKg, sets: 0 }
}

describe('buildWeeklyBarVms', () => {
  it('scales the max week to 100% and labels W1..Wn oldest-first', () => {
    const vms = buildWeeklyBarVms([week(500), week(1000), week(250)])
    expect(vms.map((v) => v.label)).toEqual(['W1', 'W2', 'W3'])
    expect(vms.map((v) => v.heightPct)).toEqual(['50%', '100%', '25%'])
  })

  it('flags only the last bin as current', () => {
    const vms = buildWeeklyBarVms([week(1), week(2), week(3)])
    expect(vms.map((v) => v.current)).toEqual([false, false, true])
  })

  it('yields all-0% (never NaN) for all-zero input', () => {
    const vms = buildWeeklyBarVms([week(0), week(0)])
    expect(vms.map((v) => v.heightPct)).toEqual(['0%', '0%'])
  })

  it('returns an empty list for empty input', () => {
    expect(buildWeeklyBarVms([])).toEqual([])
  })
})

describe('buildVolumeBarVms', () => {
  it('returns empty array for empty input', () => {
    expect(buildVolumeBarVms([])).toEqual([])
  })

  it('max group gets barFraction 1 and barWidthPct "100%"', () => {
    const groups = [
      { groupId: 'chest', groupName: 'Chest', weightedSets: 10, tonnageKg: 2000 },
      { groupId: 'back', groupName: 'Back', weightedSets: 5, tonnageKg: 1000 },
    ]
    const vms = buildVolumeBarVms(groups)
    expect(vms[0]!.barFraction).toBe(1)
    expect(vms[0]!.barWidthPct).toBe('100%')
    expect(vms[1]!.barFraction).toBe(0.5)
    expect(vms[1]!.barWidthPct).toBe('50%')
  })

  it('all-zero groups produce barFraction 0', () => {
    const groups = [
      { groupId: 'chest', groupName: 'Chest', weightedSets: 0, tonnageKg: 0 },
      { groupId: 'back', groupName: 'Back', weightedSets: 0, tonnageKg: 0 },
    ]
    const vms = buildVolumeBarVms(groups)
    expect(vms.every((v) => v.barFraction === 0)).toBe(true)
    expect(vms.every((v) => v.barWidthPct === '0%')).toBe(true)
  })

  it('preserves order and passes through groupId/groupName', () => {
    const groups = [
      { groupId: 'legs', groupName: 'Legs', weightedSets: 8, tonnageKg: 3200 },
      { groupId: 'shoulders', groupName: 'Shoulders', weightedSets: 4, tonnageKg: 400 },
    ]
    const vms = buildVolumeBarVms(groups)
    expect(vms[0]!.groupId).toBe('legs')
    expect(vms[1]!.groupId).toBe('shoulders')
    expect(vms[0]!.groupName).toBe('Legs')
  })

  it('rounds barWidthPct to integer percent', () => {
    const groups = [
      { groupId: 'a', groupName: 'A', weightedSets: 3, tonnageKg: 0 },
      { groupId: 'b', groupName: 'B', weightedSets: 7, tonnageKg: 0 },
    ]
    const vms = buildVolumeBarVms(groups)
    // 3/7 ≈ 42.857 → "43%"
    expect(vms[0]!.barWidthPct).toBe('43%')
    expect(vms[1]!.barWidthPct).toBe('100%')
  })
})

// ── formatTonnage ─────────────────────────────────────────────────────────────

describe('formatTonnage', () => {
  it('zero returns "0 kg"', () => {
    expect(formatTonnage(0)).toBe('0 kg')
  })
  it('sub-1000 returns kg', () => {
    expect(formatTonnage(500)).toBe('500 kg')
    expect(formatTonnage(999.4)).toBe('999 kg')
  })
  it('≥1000 returns tonnes with 1dp', () => {
    expect(formatTonnage(1000)).toBe('1.0t')
    expect(formatTonnage(2500)).toBe('2.5t')
  })
})

// ── formatWeightKg ────────────────────────────────────────────────────────────

describe('formatWeightKg', () => {
  it('integer kg displays without decimal', () => {
    expect(formatWeightKg(100)).toBe('100 kg')
  })
  it('fractional kg shows 1dp', () => {
    expect(formatWeightKg(102.5)).toBe('102.5 kg')
  })
})

// ── formatDistanceM ───────────────────────────────────────────────────────────

describe('formatDistanceM', () => {
  it('sub-1000 returns metres', () => {
    expect(formatDistanceM(400)).toBe('400 m')
    expect(formatDistanceM(999)).toBe('999 m')
  })
  it('≥1000 returns km with trailing zeros stripped', () => {
    expect(formatDistanceM(1000)).toBe('1km')
    expect(formatDistanceM(5000)).toBe('5km')
    expect(formatDistanceM(1500)).toBe('1.5km')
    expect(formatDistanceM(1234)).toBe('1.23km')
  })
})

// ── formatTimeS ───────────────────────────────────────────────────────────────

describe('formatTimeS', () => {
  it('sub-hour returns mm:ss with leading zero', () => {
    expect(formatTimeS(65)).toBe('01:05')
    expect(formatTimeS(3599)).toBe('59:59')
  })
  it('≥1 hour returns h:mm:ss', () => {
    expect(formatTimeS(3661)).toBe('1:01:01')
    expect(formatTimeS(7261)).toBe('2:01:01')
  })
  it('zero returns 00:00', () => {
    expect(formatTimeS(0)).toBe('00:00')
  })
})

// ── formatSets ────────────────────────────────────────────────────────────────

describe('formatSets', () => {
  it('integer value renders without decimal', () => {
    expect(formatSets(6)).toBe('6')
  })
  it('fractional value renders with 1dp', () => {
    expect(formatSets(6.5)).toBe('6.5')
  })
  it('zero returns "0"', () => {
    expect(formatSets(0)).toBe('0')
  })
})

// ── formatPrDate ──────────────────────────────────────────────────────────────

describe('formatPrDate', () => {
  it('formats an ISO date string as "D Mon YYYY"', () => {
    expect(formatPrDate('2026-06-20')).toBe('20 Jun 2026')
    expect(formatPrDate('2026-01-01')).toBe('1 Jan 2026')
  })
})

// ── buildPrRowVms ─────────────────────────────────────────────────────────────

describe('buildPrRowVms', () => {
  it('returns empty array for empty input', () => {
    expect(buildPrRowVms([])).toEqual([])
  })

  it('formats strength PR fields', () => {
    const rows = buildPrRowVms([
      {
        exerciseId: 'squat',
        exerciseName: 'Squat',
        bestE1rmKg: 120,
        bestE1rmAt: '2026-06-10',
        heaviestLoadKg: 110,
        heaviestLoadAt: '2026-06-01',
        longestDistanceM: null,
        fastestTimeS: null,
      },
    ])
    expect(rows[0]!.bestE1rmDisplay).toBe('120 kg')
    expect(rows[0]!.bestE1rmDateDisplay).toBe('10 Jun 2026')
    expect(rows[0]!.heaviestLoadDisplay).toBe('110 kg')
    expect(rows[0]!.longestDistanceDisplay).toBeNull()
    expect(rows[0]!.fastestTimeDisplay).toBeNull()
    expect(rows[0]!.category).toBe('strength')
  })

  it('formats endurance PR fields', () => {
    const rows = buildPrRowVms([
      {
        exerciseId: 'run',
        exerciseName: 'Run',
        bestE1rmKg: null,
        bestE1rmAt: null,
        heaviestLoadKg: null,
        heaviestLoadAt: null,
        longestDistanceM: 5000,
        fastestTimeS: 1200,
      },
    ])
    expect(rows[0]!.longestDistanceDisplay).toBe('5km')
    expect(rows[0]!.fastestTimeDisplay).toBe('20:00')
    expect(rows[0]!.category).toBe('endurance')
    expect(rows[0]!.bestE1rmDisplay).toBeNull()
  })

  it('strength category sorts before endurance', () => {
    const rows = buildPrRowVms([
      {
        exerciseId: 'run',
        exerciseName: 'Run',
        bestE1rmKg: null,
        bestE1rmAt: null,
        heaviestLoadKg: null,
        heaviestLoadAt: null,
        longestDistanceM: 5000,
        fastestTimeS: 1200,
      },
      {
        exerciseId: 'squat',
        exerciseName: 'Squat',
        bestE1rmKg: 120,
        bestE1rmAt: '2026-06-10',
        heaviestLoadKg: 110,
        heaviestLoadAt: '2026-06-01',
        longestDistanceM: null,
        fastestTimeS: null,
      },
    ])
    expect(rows[0]!.exerciseId).toBe('squat')
    expect(rows[1]!.exerciseId).toBe('run')
  })

  it('sorts alphabetically within a category', () => {
    const rows = buildPrRowVms([
      {
        exerciseId: 'bench',
        exerciseName: 'Bench Press',
        bestE1rmKg: 90,
        bestE1rmAt: '2026-06-01',
        heaviestLoadKg: 80,
        heaviestLoadAt: '2026-06-01',
        longestDistanceM: null,
        fastestTimeS: null,
      },
      {
        exerciseId: 'squat',
        exerciseName: 'Squat',
        bestE1rmKg: 120,
        bestE1rmAt: '2026-06-10',
        heaviestLoadKg: 110,
        heaviestLoadAt: '2026-06-01',
        longestDistanceM: null,
        fastestTimeS: null,
      },
      {
        exerciseId: 'dl',
        exerciseName: 'Deadlift',
        bestE1rmKg: 150,
        bestE1rmAt: '2026-06-05',
        heaviestLoadKg: 140,
        heaviestLoadAt: '2026-06-05',
        longestDistanceM: null,
        fastestTimeS: null,
      },
    ])
    const names = rows.map((r) => r.exerciseName)
    expect(names).toEqual(['Bench Press', 'Deadlift', 'Squat'])
  })

  it('null pr fields produce null display strings', () => {
    const rows = buildPrRowVms([
      {
        exerciseId: 'row',
        exerciseName: 'Row',
        bestE1rmKg: null,
        bestE1rmAt: null,
        heaviestLoadKg: 60,
        heaviestLoadAt: '2026-06-01',
        longestDistanceM: null,
        fastestTimeS: null,
      },
    ])
    expect(rows[0]!.bestE1rmDisplay).toBeNull()
    expect(rows[0]!.bestE1rmDateDisplay).toBeNull()
    expect(rows[0]!.heaviestLoadDisplay).toBe('60 kg')
  })
})
