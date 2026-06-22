import { describe, it, expect } from 'vitest'
import { observedDate, nthWeekday, lastWeekday, expandHolidays } from './holidays.js'

describe('observedDate', () => {
  it('leaves weekdays unchanged', () => {
    // 2026-07-04 is a Saturday; but test a weekday: 2026-07-06 is Monday
    expect(observedDate('2026-07-06')).toBe('2026-07-06')
    expect(observedDate('2026-07-07')).toBe('2026-07-07') // Tuesday
  })

  it('shifts Saturday to Friday', () => {
    // 2026-07-04 = Saturday
    expect(observedDate('2026-07-04')).toBe('2026-07-03')
  })

  it('shifts Sunday to Monday', () => {
    // 2027-07-04 = Sunday
    expect(observedDate('2027-07-04')).toBe('2027-07-05')
  })

  it('does not shift an already-weekday holiday', () => {
    // 2026-01-01 = Thursday
    expect(observedDate('2026-01-01')).toBe('2026-01-01')
  })
})

describe('nthWeekday', () => {
  it('returns the 3rd Monday of January 2026', () => {
    // Jan 2026: 1st is Thursday; 1st Mon=5, 2nd=12, 3rd=19
    expect(nthWeekday(2026, 1, 1, 3)).toBe('2026-01-19')
  })

  it('returns the 1st Monday of September 2026 (Labor Day)', () => {
    // Sep 2026: 1st is Tuesday; 1st Mon = 7
    expect(nthWeekday(2026, 9, 1, 1)).toBe('2026-09-07')
  })

  it('returns the 4th Thursday of November 2026 (Thanksgiving)', () => {
    // Nov 2026: 1st is Sunday; 1st Thu = 5, 2nd=12, 3rd=19, 4th=26
    expect(nthWeekday(2026, 11, 4, 4)).toBe('2026-11-26')
  })

  it('returns the 2nd Monday of October 2026 (Columbus Day)', () => {
    // Oct 2026: 1st is Thursday; 1st Mon = 5, 2nd = 12
    expect(nthWeekday(2026, 10, 1, 2)).toBe('2026-10-12')
  })
})

describe('lastWeekday', () => {
  it('returns the last Monday of May 2026 (Memorial Day)', () => {
    // May 2026: 31 is Sunday; last Mon = 25
    expect(lastWeekday(2026, 5, 1)).toBe('2026-05-25')
  })

  it('returns the last Monday of May 2025 (Memorial Day)', () => {
    // May 2025: 31 is Saturday; last Mon = 26
    expect(lastWeekday(2025, 5, 1)).toBe('2025-05-26')
  })
})

describe('expandHolidays', () => {
  it('returns all 11 US federal holidays for a full year', () => {
    const holidays = expandHolidays('2026-01-01', '2026-12-31')
    expect(holidays).toHaveLength(11)
    const ids = holidays.map((h) => h.id)
    expect(ids).toContain('us-federal:new-years')
    expect(ids).toContain('us-federal:mlk')
    expect(ids).toContain('us-federal:washington')
    expect(ids).toContain('us-federal:memorial')
    expect(ids).toContain('us-federal:juneteenth')
    expect(ids).toContain('us-federal:independence')
    expect(ids).toContain('us-federal:labor')
    expect(ids).toContain('us-federal:columbus')
    expect(ids).toContain('us-federal:veterans')
    expect(ids).toContain('us-federal:thanksgiving')
    expect(ids).toContain('us-federal:christmas')
  })

  it('sorts by observedDate', () => {
    const holidays = expandHolidays('2026-01-01', '2026-12-31')
    for (let i = 1; i < holidays.length; i++) {
      expect(holidays[i]!.observedDate >= holidays[i - 1]!.observedDate).toBe(true)
    }
  })

  it('excludes holidays outside the window', () => {
    // Only Q1 holidays
    const holidays = expandHolidays('2026-01-01', '2026-03-31')
    const ids = holidays.map((h) => h.id)
    expect(ids).toContain('us-federal:new-years')
    expect(ids).toContain('us-federal:mlk')
    expect(ids).toContain('us-federal:washington')
    expect(ids).not.toContain('us-federal:memorial')
    expect(ids).not.toContain('us-federal:independence')
    expect(ids).not.toContain('us-federal:thanksgiving')
  })

  it('spans across year boundaries', () => {
    const holidays = expandHolidays('2025-12-01', '2026-01-31')
    const ids = holidays.map((h) => h.id)
    expect(ids).toContain('us-federal:christmas') // Dec 25
    expect(ids).toContain('us-federal:new-years')  // Jan 1
  })

  it('applies observed-date shift for Saturday holidays', () => {
    // Independence Day 2026 = Saturday July 4 → observed Friday July 3
    const holidays = expandHolidays('2026-07-01', '2026-07-31')
    const independence = holidays.find((h) => h.id === 'us-federal:independence')
    expect(independence).toBeDefined()
    expect(independence!.date).toBe('2026-07-04')
    expect(independence!.observedDate).toBe('2026-07-03')
  })

  it('applies observed-date shift for Sunday holidays', () => {
    // Independence Day 2027 = Sunday July 4 → observed Monday July 5
    const holidays = expandHolidays('2027-07-01', '2027-07-31')
    const independence = holidays.find((h) => h.id === 'us-federal:independence')
    expect(independence).toBeDefined()
    expect(independence!.date).toBe('2027-07-04')
    expect(independence!.observedDate).toBe('2027-07-05')
  })

  it('returns empty array for empty window', () => {
    // Window between holidays
    const holidays = expandHolidays('2026-07-05', '2026-07-31')
    expect(holidays).toHaveLength(0)
  })
})
