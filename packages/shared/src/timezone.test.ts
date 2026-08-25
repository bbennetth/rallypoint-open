import { describe, it, expect } from 'vitest'
import {
  zonedDayWindow,
  nextCalendarDate,
  dayInstant,
  wallClockToInstant,
  localAnchor,
} from './timezone.js'

// Timezone helpers, moved here from planner-api's day-window.ts + assist.ts
// (thin-BFF cleanup): the tz math is generic, so it lives in @rallypoint/shared
// with its coverage.

describe('nextCalendarDate', () => {
  it('advances within a month', () => {
    expect(nextCalendarDate('2026-06-03')).toBe('2026-06-04')
  })
  it('rolls over month and year boundaries', () => {
    expect(nextCalendarDate('2026-06-30')).toBe('2026-07-01')
    expect(nextCalendarDate('2026-12-31')).toBe('2027-01-01')
  })
  it('handles leap vs non-leap February', () => {
    expect(nextCalendarDate('2024-02-28')).toBe('2024-02-29')
    expect(nextCalendarDate('2026-02-28')).toBe('2026-03-01')
  })
})

describe('zonedDayWindow', () => {
  it('spans exactly UTC midnight-to-midnight for UTC', () => {
    expect(zonedDayWindow('2026-06-03', 'UTC')).toEqual({
      start: '2026-06-03T00:00:00.000Z',
      end: '2026-06-04T00:00:00.000Z',
    })
  })

  it('shifts the window east for a +05:30 zone', () => {
    // Local midnight in Kolkata is 18:30 UTC the previous day.
    expect(zonedDayWindow('2026-06-03', 'Asia/Kolkata')).toEqual({
      start: '2026-06-02T18:30:00.000Z',
      end: '2026-06-03T18:30:00.000Z',
    })
  })

  it('shifts the window west for a negative-offset zone', () => {
    // Chicago is CDT (-05:00) in June.
    expect(zonedDayWindow('2026-06-03', 'America/Chicago')).toEqual({
      start: '2026-06-03T05:00:00.000Z',
      end: '2026-06-04T05:00:00.000Z',
    })
  })

  it('respects DST: New York is -05:00 in winter, -04:00 in summer', () => {
    expect(zonedDayWindow('2026-01-15', 'America/New_York').start).toBe('2026-01-15T05:00:00.000Z')
    expect(zonedDayWindow('2026-07-15', 'America/New_York').start).toBe('2026-07-15T04:00:00.000Z')
  })

  it('produces a 23-hour window on the US spring-forward day', () => {
    // 2026-03-08: clocks jump 02:00→03:00 in America/New_York, so the local
    // day is only 23h of real time. The two-pass offset resolution must land
    // on the right side of the gap.
    const w = zonedDayWindow('2026-03-08', 'America/New_York')
    const hours = (Date.parse(w.end) - Date.parse(w.start)) / 3_600_000
    expect(hours).toBe(23)
  })

  it('produces a 25-hour window on the US fall-back day', () => {
    // 2026-11-01: clocks fall 02:00→01:00, so the local day is 25h.
    const w = zonedDayWindow('2026-11-01', 'America/New_York')
    const hours = (Date.parse(w.end) - Date.parse(w.start)) / 3_600_000
    expect(hours).toBe(25)
  })
})

describe('dayInstant', () => {
  it('pins an all-day day (null start) to the start of the local day', () => {
    expect(dayInstant('2026-06-03', null, 'UTC')).toBe('2026-06-03T00:00:00.000Z')
    // Same as the day window's start in a shifted zone.
    expect(dayInstant('2026-06-03', null, 'America/Chicago')).toBe('2026-06-03T05:00:00.000Z')
  })

  it('resolves a timed day to its wall-clock time in the zone', () => {
    expect(dayInstant('2026-06-03', '09:00', 'UTC')).toBe('2026-06-03T09:00:00.000Z')
    // 09:00 CDT (-05:00) is 14:00 UTC.
    expect(dayInstant('2026-06-03', '09:00', 'America/Chicago')).toBe('2026-06-03T14:00:00.000Z')
  })

  it('accepts an HH:MM:SS time (postgres time round-trips)', () => {
    expect(dayInstant('2026-06-03', '09:30:00', 'UTC')).toBe('2026-06-03T09:30:00.000Z')
  })

  it('resolves a wall-clock time in the spring-forward gap to the post-gap instant', () => {
    // 2026-03-08 in America/New_York: clocks jump 02:00 → 03:00, so 02:30 has
    // no real local instant. The two-pass offset lands on the post-gap side
    // (effective -04:00), so 02:30 resolves to 06:30 UTC.
    expect(dayInstant('2026-03-08', '02:30', 'America/New_York')).toBe('2026-03-08T06:30:00.000Z')
  })
})

// E2 #15 regression: zonedDayWindow / tzOffsetMs at the DST spring-forward
// boundary previously produced an off-by-24h offset when Intl rendered
// midnight as hour=24 on the preceding date. The fix advances the calendar by
// one day before computing UTC midnight.
describe('zonedDayWindow — DST spring-forward window correctness (#15)', () => {
  it('returns a 23-hour window for the US DST spring-forward day', () => {
    const w = zonedDayWindow('2026-03-08', 'America/New_York')
    const hours = (Date.parse(w.end) - Date.parse(w.start)) / 3_600_000
    expect(hours).toBe(23)
    // Start is local midnight 2026-03-08 in America/New_York = 05:00 UTC
    // (EST, before the spring-forward jump). End is local midnight
    // 2026-03-09 = 04:00 UTC (EDT, after the jump).
    expect(w.start).toBe('2026-03-08T05:00:00.000Z')
    expect(w.end).toBe('2026-03-09T04:00:00.000Z')
  })

  it('returns a 23-hour window for the UK BST spring-forward day', () => {
    // 2026-03-29: clocks go from 01:00 GMT → 02:00 BST.
    const w = zonedDayWindow('2026-03-29', 'Europe/London')
    const hours = (Date.parse(w.end) - Date.parse(w.start)) / 3_600_000
    expect(hours).toBe(23)
  })
})

describe('wallClockToInstant', () => {
  it('resolves a fixed-offset zone exactly', () => {
    // America/Chicago is UTC-5 in July (CDT): 09:00 local → 14:00Z.
    const inst = wallClockToInstant('2027-07-05', '09:00', 'America/Chicago')
    expect(inst?.toISOString()).toBe('2027-07-05T14:00:00.000Z')
  })

  it('honours standard-time offset (winter)', () => {
    // CST is UTC-6 in January: 09:00 local → 15:00Z.
    const inst = wallClockToInstant('2027-01-05', '09:00', 'America/Chicago')
    expect(inst?.toISOString()).toBe('2027-01-05T15:00:00.000Z')
  })

  it('resolves UTC identically', () => {
    expect(wallClockToInstant('2027-03-05', '09:00', 'UTC')?.toISOString()).toBe(
      '2027-03-05T09:00:00.000Z',
    )
  })

  it('accepts an HH:MM:SS time', () => {
    expect(wallClockToInstant('2027-07-05', '09:00:00', 'UTC')?.toISOString()).toBe(
      '2027-07-05T09:00:00.000Z',
    )
  })

  it('does not throw across a DST spring-forward boundary', () => {
    // 2027-03-14 02:30 does not exist in America/Chicago (spring forward);
    // the resolver must still return a plausible instant, not throw/NaN.
    const inst = wallClockToInstant('2027-03-14', '02:30', 'America/Chicago')
    expect(inst).not.toBeNull()
    expect(Number.isNaN(inst!.getTime())).toBe(false)
  })

  it('returns null for malformed date/time', () => {
    expect(wallClockToInstant('not-a-date', '09:00', 'UTC')).toBeNull()
    expect(wallClockToInstant('2027-07-05', '9am', 'UTC')).toBeNull()
  })
})

describe('localAnchor', () => {
  it('resolves the instant into the local wall clock for the zone', () => {
    // 2026-07-20T02:00:00Z is still 2026-07-19 in Chicago (UTC-5 in July).
    const a = localAnchor('2026-07-20T02:00:00Z', 'America/Chicago')
    expect(a.date).toBe('2026-07-19')
    expect(a.time).toBe('21:00')
    expect(a.weekday).toBe('Sunday')
  })
})
