import { describe, it, expect } from 'vitest'
import {
  CreateSeriesSchema,
  MAX_INSTANCES_PER_SERIES,
  UpdateSeriesSchema,
  expandOccurrences,
  materializeOccurrences,
  occurrenceDueDate,
  type RecurrenceRule,
} from './recurrence.js'

describe('expandOccurrences — daily', () => {
  it('emits every day at interval 1 within the window', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, dtstart: '2026-06-01' }
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-04' })).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
    ])
  })

  it('steps by interval counting from dtstart', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 3, dtstart: '2026-06-01' }
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-10' })).toEqual([
      '2026-06-01',
      '2026-06-04',
      '2026-06-07',
      '2026-06-10',
    ])
  })

  it('keeps the interval phase when the window starts after dtstart', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 3, dtstart: '2026-06-01' }
    // 06-01,04,07,10 — window clips to the two in range, phase preserved.
    expect(expandOccurrences(rule, { from: '2026-06-05', to: '2026-06-10' })).toEqual([
      '2026-06-07',
      '2026-06-10',
    ])
  })
})

describe('expandOccurrences — weekly', () => {
  it('defaults to dtstart weekday when byDay is absent', () => {
    // 2026-06-01 is a Monday.
    const rule: RecurrenceRule = { freq: 'weekly', interval: 1, dtstart: '2026-06-01' }
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-22' })).toEqual([
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
      '2026-06-22',
    ])
  })

  it('expands every listed weekday', () => {
    // Mondays + Wednesdays starting Mon 2026-06-01.
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO', 'WE'],
      dtstart: '2026-06-01',
    }
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-14' })).toEqual([
      '2026-06-01',
      '2026-06-03',
      '2026-06-08',
      '2026-06-10',
    ])
  })

  it('honours a multi-week interval anchored to dtstart week', () => {
    // Every 2 weeks on Monday from Mon 2026-06-01 → skips 06-08, 06-22.
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 2,
      byDay: ['MO'],
      dtstart: '2026-06-01',
    }
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-30' })).toEqual([
      '2026-06-01',
      '2026-06-15',
      '2026-06-29',
    ])
  })
})

describe('expandOccurrences — termination', () => {
  it('stops at the until bound (inclusive)', () => {
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtstart: '2026-06-01',
      until: '2026-06-03',
    }
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-30' })).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ])
  })

  it('stops after count occurrences counted from dtstart', () => {
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtstart: '2026-06-01',
      count: 2,
    }
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-30' })).toEqual([
      '2026-06-01',
      '2026-06-02',
    ])
  })

  it('counts toward count even for occurrences before the window start', () => {
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtstart: '2026-06-01',
      count: 3,
    }
    // Only 06-01,02,03 exist; window starts 06-03 so just the last shows.
    expect(expandOccurrences(rule, { from: '2026-06-03', to: '2026-06-30' })).toEqual([
      '2026-06-03',
    ])
  })

  it('returns nothing for a window entirely before dtstart', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, dtstart: '2026-06-10' }
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-05' })).toEqual([])
  })

  it('yields a single occurrence when until equals dtstart', () => {
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtstart: '2026-06-01',
      until: '2026-06-01',
    }
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-30' })).toEqual([
      '2026-06-01',
    ])
  })

  it('coerces a sub-1 interval to 1 (raw-rule contract guard)', () => {
    // The validators enforce interval >= 1; this documents the expander's
    // own guard for a rule that bypasses them.
    const rule: RecurrenceRule = { freq: 'daily', interval: 0, dtstart: '2026-06-01' }
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-03' })).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ])
  })

  it('caps count at the occurrences the window actually yields', () => {
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtstart: '2026-06-01',
      count: 10,
    }
    // count=10 but the window only spans three days.
    expect(expandOccurrences(rule, { from: '2026-06-01', to: '2026-06-03' })).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ])
  })

  it('throws when an unbounded window would exceed the per-series cap', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, dtstart: '2026-06-01' }
    expect(() =>
      expandOccurrences(rule, { from: '2026-06-01', to: '2027-06-01' }),
    ).toThrow(RangeError)
  })

  it('returns exactly the cap without throwing at the boundary', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, dtstart: '2026-06-01' }
    // 50 days inclusive: 06-01 .. 07-20.
    const out = expandOccurrences(rule, { from: '2026-06-01', to: '2026-07-20' })
    expect(out).toHaveLength(MAX_INSTANCES_PER_SERIES)
  })
})

describe('materializeOccurrences', () => {
  it('yields exactly limit dates for an open-ended rule (no throw)', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, dtstart: '2026-06-01' }
    const out = materializeOccurrences(rule, { from: '2026-06-01', limit: 5 })
    expect(out).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ])
  })

  it('clamps limit to the per-series cap', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, dtstart: '2026-06-01' }
    const out = materializeOccurrences(rule, { from: '2026-06-01', limit: 1000 })
    expect(out).toHaveLength(MAX_INSTANCES_PER_SERIES)
  })

  it('defaults limit to the per-series cap when omitted', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, dtstart: '2026-06-01' }
    expect(materializeOccurrences(rule, { from: '2026-06-01' })).toHaveLength(
      MAX_INSTANCES_PER_SERIES,
    )
  })

  it('rolls forward from `from`, not dtstart, but honours count globally', () => {
    // count=4 from dtstart 06-01: 06-01,02,03,04. from 06-03 → tail only.
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      dtstart: '2026-06-01',
      count: 4,
    }
    expect(materializeOccurrences(rule, { from: '2026-06-03', limit: 50 })).toEqual([
      '2026-06-03',
      '2026-06-04',
    ])
  })

  it('stops at until before reaching the limit', () => {
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byDay: ['MO'],
      dtstart: '2026-06-01',
      until: '2026-06-15',
    }
    expect(materializeOccurrences(rule, { from: '2026-06-01', limit: 50 })).toEqual([
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
    ])
  })

  it('returns nothing for a zero limit', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, dtstart: '2026-06-01' }
    expect(materializeOccurrences(rule, { from: '2026-06-01', limit: 0 })).toEqual([])
  })
})

describe('occurrenceDueDate', () => {
  it('anchors to start-of-day UTC when no time is set', () => {
    expect(occurrenceDueDate('2026-06-01', null)).toBe('2026-06-01T00:00:00.000Z')
  })

  it('combines an HH:MM time', () => {
    expect(occurrenceDueDate('2026-06-01', '09:30')).toBe('2026-06-01T09:30:00.000Z')
  })

  it('combines an HH:MM:SS time', () => {
    expect(occurrenceDueDate('2026-06-01', '09:30:15')).toBe('2026-06-01T09:30:15.000Z')
  })
})

describe('CreateSeriesSchema', () => {
  const base = { title: 'Water the plants', freq: 'weekly', dtstart: '2026-06-01' }

  it('accepts a weekly rule and defaults interval to 1', () => {
    const parsed = CreateSeriesSchema.parse({ ...base, byDay: ['MO', 'WE'] })
    expect(parsed.interval).toBe(1)
    expect(parsed.byDay).toEqual(['MO', 'WE'])
  })

  it('dedupes byDay codes', () => {
    const parsed = CreateSeriesSchema.parse({ ...base, byDay: ['MO', 'MO', 'WE'] })
    expect(parsed.byDay).toEqual(['MO', 'WE'])
  })

  it('rejects byDay on a daily rule', () => {
    const r = CreateSeriesSchema.safeParse({ ...base, freq: 'daily', byDay: ['MO'] })
    expect(r.success).toBe(false)
  })

  it('rejects specifying both until and count', () => {
    const r = CreateSeriesSchema.safeParse({
      ...base,
      until: '2026-12-31',
      count: 5,
    })
    expect(r.success).toBe(false)
  })

  it('rejects until before dtstart', () => {
    const r = CreateSeriesSchema.safeParse({ ...base, until: '2026-05-01' })
    expect(r.success).toBe(false)
  })

  it('rejects a count above the per-series cap', () => {
    const r = CreateSeriesSchema.safeParse({ ...base, count: MAX_INSTANCES_PER_SERIES + 1 })
    expect(r.success).toBe(false)
  })

  it('rejects a malformed calendar date', () => {
    expect(CreateSeriesSchema.safeParse({ ...base, dtstart: '2026-02-31' }).success).toBe(false)
    expect(CreateSeriesSchema.safeParse({ ...base, dtstart: '06/01/2026' }).success).toBe(false)
  })

  it('normalises an empty time-of-day to null', () => {
    const parsed = CreateSeriesSchema.parse({ ...base, timeOfDay: '' })
    expect(parsed.timeOfDay).toBeNull()
  })
})

describe('UpdateSeriesSchema', () => {
  it('requires at least one field', () => {
    expect(UpdateSeriesSchema.safeParse({}).success).toBe(false)
  })

  it('accepts a lone interval bump', () => {
    expect(UpdateSeriesSchema.safeParse({ interval: 2 }).success).toBe(true)
  })

  it('rejects byDay with an explicit daily freq in the same patch', () => {
    expect(UpdateSeriesSchema.safeParse({ freq: 'daily', byDay: ['MO'] }).success).toBe(false)
  })
})
