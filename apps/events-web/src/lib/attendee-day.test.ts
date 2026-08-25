import { describe, expect, it } from 'vitest'
import {
  buildHourGroups,
  defaultDateForEvent,
  hm,
  hourBucket,
  labelForDay,
} from './attendee-day.js'

function day(date: string, sortOrder: number) {
  return { date, sort_order: sortOrder }
}

describe('defaultDateForEvent', () => {
  it('keeps today when it is one of the event days', () => {
    const days = [day('2026-07-03', 0), day('2026-07-04', 1), day('2026-07-05', 2)]
    expect(defaultDateForEvent(days, '2026-07-04')).toBe('2026-07-04')
  })

  it('falls back to the first day when the event has not started', () => {
    const days = [day('2026-07-05', 2), day('2026-07-03', 0), day('2026-07-04', 1)]
    expect(defaultDateForEvent(days, '2026-06-01')).toBe('2026-07-03')
  })

  it('falls back to the first day when the event is over', () => {
    const days = [day('2026-07-03', 0), day('2026-07-04', 1)]
    expect(defaultDateForEvent(days, '2026-09-01')).toBe('2026-07-03')
  })

  it('orders by sort_order, not by date', () => {
    // An organiser can order days however they like; sort_order wins.
    const days = [day('2026-07-05', 0), day('2026-07-03', 1)]
    expect(defaultDateForEvent(days, '2026-01-01')).toBe('2026-07-05')
  })

  it('returns today when the event has no days published', () => {
    expect(defaultDateForEvent([], '2026-07-04')).toBe('2026-07-04')
  })

  it('does not mutate the caller array', () => {
    const days = [day('2026-07-05', 2), day('2026-07-03', 0)]
    defaultDateForEvent(days, '2026-01-01')
    expect(days[0]!.date).toBe('2026-07-05')
  })
})

describe('hourBucket', () => {
  it('buckets a timestamp to its hour', () => {
    expect(hourBucket('14:35:00')).toBe('14:00')
    expect(hourBucket('00:05:00')).toBe('00:00')
  })

  it('marks untimed rows', () => {
    expect(hourBucket(null)).toBe('—')
    expect(hourBucket('')).toBe('—')
    expect(hourBucket('later')).toBe('—')
  })
})

describe('hm', () => {
  it('trims seconds off a time', () => {
    expect(hm('14:35:00')).toBe('14:35')
    expect(hm('14:35')).toBe('14:35')
  })

  it('passes through anything unparseable', () => {
    expect(hm(null)).toBe('')
    expect(hm('doors')).toBe('doors')
  })
})

describe('buildHourGroups', () => {
  it('sorts by time and merges adjacent rows of the same hour', () => {
    const groups = buildHourGroups([
      { key: 'b', time: '14:50:00' },
      { key: 'c', time: '15:10:00' },
      { key: 'a', time: '14:05:00' },
    ])
    expect(groups.map((g) => g.hour)).toEqual(['14:00', '15:00'])
    expect(groups[0]!.rows.map((r) => r.key)).toEqual(['a', 'b'])
    expect(groups[1]!.rows.map((r) => r.key)).toEqual(['c'])
  })

  it('sinks untimed rows to the end under a no-time bucket', () => {
    const groups = buildHourGroups([
      { key: 'task', time: null },
      { key: 'set', time: '09:00:00' },
    ])
    expect(groups.map((g) => g.hour)).toEqual(['09:00', '—'])
    expect(groups[1]!.rows.map((r) => r.key)).toEqual(['task'])
  })

  it('keeps caller order for rows sharing a time', () => {
    const groups = buildHourGroups([
      { key: 'rally', time: '12:00:00' },
      { key: 'set', time: '12:00:00' },
    ])
    expect(groups[0]!.rows.map((r) => r.key)).toEqual(['rally', 'set'])
  })

  it('reopens a bucket when a later row returns to an earlier hour', () => {
    // Sorting happens first, so same-hour rows always end up in one group.
    const groups = buildHourGroups([
      { key: 'a', time: '10:00:00' },
      { key: 'b', time: '11:00:00' },
      { key: 'c', time: '10:30:00' },
    ])
    expect(groups.map((g) => g.hour)).toEqual(['10:00', '11:00'])
    expect(groups[0]!.rows.map((r) => r.key)).toEqual(['a', 'c'])
  })

  it('returns nothing for an empty agenda', () => {
    expect(buildHourGroups([])).toEqual([])
  })

  it('does not mutate the caller array', () => {
    const rows = [
      { key: 'b', time: '14:50:00' },
      { key: 'a', time: '09:00:00' },
    ]
    buildHourGroups(rows)
    expect(rows.map((r) => r.key)).toEqual(['b', 'a'])
  })
})

describe('labelForDay', () => {
  // Don't assert the formatted string — it's locale/timezone dependent.
  it('passes an unparseable date straight through', () => {
    expect(labelForDay('not-a-date')).toBe('not-a-date')
  })

  it('formats a valid ISO date to something non-empty', () => {
    const label = labelForDay('2026-07-04')
    expect(label).not.toBe('2026-07-04')
    expect(label.length).toBeGreaterThan(0)
  })
})
