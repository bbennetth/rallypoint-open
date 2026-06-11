import { describe, it, expect } from 'vitest'
import { generateDays, dayTimesIssue } from './day-generation.js'

describe('generateDays', () => {
  it('generates one Day N per date across an inclusive range', () => {
    const out = generateDays({ startDate: '2026-05-01', endDate: '2026-05-07' })
    expect(out).toEqual([
      { dayLabel: 'Day 1', date: '2026-05-01' },
      { dayLabel: 'Day 2', date: '2026-05-02' },
      { dayLabel: 'Day 3', date: '2026-05-03' },
      { dayLabel: 'Day 4', date: '2026-05-04' },
      { dayLabel: 'Day 5', date: '2026-05-05' },
      { dayLabel: 'Day 6', date: '2026-05-06' },
      { dayLabel: 'Day 7', date: '2026-05-07' },
    ])
  })

  it('handles a single-day range', () => {
    expect(generateDays({ startDate: '2026-05-01', endDate: '2026-05-01' })).toEqual([
      { dayLabel: 'Day 1', date: '2026-05-01' },
    ])
  })

  it('crosses a month boundary correctly', () => {
    const out = generateDays({ startDate: '2026-01-30', endDate: '2026-02-02' })
    expect(out.map((d) => d.date)).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02'])
  })

  it('skips dates that already exist and continues numbering past them', () => {
    const out = generateDays({
      startDate: '2026-05-01',
      endDate: '2026-05-05',
      existing: ['2026-05-01', '2026-05-02'],
    })
    // Two days already present → new days are numbered Day 3 onward and the
    // existing dates are not re-emitted.
    expect(out).toEqual([
      { dayLabel: 'Day 3', date: '2026-05-03' },
      { dayLabel: 'Day 4', date: '2026-05-04' },
      { dayLabel: 'Day 5', date: '2026-05-05' },
    ])
  })

  it('skips an interior existing date but keeps contiguous labels', () => {
    const out = generateDays({
      startDate: '2026-05-01',
      endDate: '2026-05-04',
      existing: ['2026-05-02'],
    })
    expect(out).toEqual([
      { dayLabel: 'Day 2', date: '2026-05-01' },
      { dayLabel: 'Day 3', date: '2026-05-03' },
      { dayLabel: 'Day 4', date: '2026-05-04' },
    ])
  })

  it('honours an explicit startIndex', () => {
    const out = generateDays({ startDate: '2026-05-01', endDate: '2026-05-02', startIndex: 10 })
    expect(out.map((d) => d.dayLabel)).toEqual(['Day 10', 'Day 11'])
  })

  it('returns [] for an inverted range', () => {
    expect(generateDays({ startDate: '2026-05-07', endDate: '2026-05-01' })).toEqual([])
  })

  it('returns [] for an invalid calendar date', () => {
    expect(generateDays({ startDate: '2026-02-30', endDate: '2026-03-02' })).toEqual([])
    expect(generateDays({ startDate: 'nope', endDate: '2026-03-02' })).toEqual([])
  })

  it('returns [] when every date in range already exists', () => {
    expect(
      generateDays({
        startDate: '2026-05-01',
        endDate: '2026-05-02',
        existing: ['2026-05-01', '2026-05-02'],
      }),
    ).toEqual([])
  })

  it('caps a pathological range at 366 days', () => {
    const out = generateDays({ startDate: '2000-01-01', endDate: '2010-01-01' })
    expect(out).toHaveLength(366)
  })
})

describe('dayTimesIssue', () => {
  it('accepts both blank (all-day)', () => {
    expect(dayTimesIssue(null, null)).toBeNull()
    expect(dayTimesIssue(undefined, undefined)).toBeNull()
  })

  it('accepts a valid window where end is after start', () => {
    expect(dayTimesIssue('09:00', '17:00')).toBeNull()
  })

  it('accepts an instant window where end equals start', () => {
    expect(dayTimesIssue('09:00', '09:00')).toBeNull()
  })

  it('rejects only one side set', () => {
    expect(dayTimesIssue('09:00', null)).toBe('both_required')
    expect(dayTimesIssue(null, '17:00')).toBe('both_required')
    expect(dayTimesIssue('09:00', undefined)).toBe('both_required')
  })

  it('rejects end before start', () => {
    expect(dayTimesIssue('17:00', '09:00')).toBe('end_before_start')
  })
})
