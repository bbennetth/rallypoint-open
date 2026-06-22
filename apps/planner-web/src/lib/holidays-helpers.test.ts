import { describe, it, expect } from 'vitest'
import {
  holidaysEnabled,
  hiddenHolidays,
  holidaysOnDay,
  holidaysToGroups,
  mergeEventsAndHolidays,
  upcomingFeedGroups,
} from './holidays-helpers.js'
import type { HolidayDto, PersonalEventDto, UpcomingItem } from './api.js'

describe('holidaysEnabled', () => {
  it('returns true when the key is absent', () => {
    expect(holidaysEnabled({})).toBe(true)
  })

  it('returns true when the key is explicitly true', () => {
    expect(holidaysEnabled({ holidaysEnabled: true })).toBe(true)
  })

  it('returns false when the key is explicitly false', () => {
    expect(holidaysEnabled({ holidaysEnabled: false })).toBe(false)
  })

  it('returns true when the key is some other truthy value', () => {
    expect(holidaysEnabled({ holidaysEnabled: 1 })).toBe(true)
  })
})

describe('hiddenHolidays', () => {
  it('returns [] when the key is absent', () => {
    expect(hiddenHolidays({})).toEqual([])
  })

  it('returns [] when the value is not an array', () => {
    expect(hiddenHolidays({ hiddenHolidays: 'foo' })).toEqual([])
    expect(hiddenHolidays({ hiddenHolidays: 42 })).toEqual([])
  })

  it('returns the string ids when the value is a string array', () => {
    expect(hiddenHolidays({ hiddenHolidays: ['us-federal:independence', 'us-federal:labor'] }))
      .toEqual(['us-federal:independence', 'us-federal:labor'])
  })

  it('filters out non-string entries', () => {
    expect(hiddenHolidays({ hiddenHolidays: ['us-federal:independence', 42, null, 'us-federal:labor'] }))
      .toEqual(['us-federal:independence', 'us-federal:labor'])
  })
})

describe('holidaysToGroups', () => {
  const today = '2026-01-01'

  function makeHoliday(id: string, observedDate: string): HolidayDto {
    return { id, name: id, date: observedDate, observedDate }
  }

  it('returns empty array for empty input', () => {
    expect(holidaysToGroups([], today)).toEqual([])
  })

  it('returns a single group with one item for a single holiday', () => {
    const h = makeHoliday('us-federal:independence', '2026-07-03')
    const groups = holidaysToGroups([h], today)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.ymd).toBe('2026-07-03')
    expect(groups[0]!.items).toHaveLength(1)
    expect(groups[0]!.items[0]).toEqual({ kind: 'holiday', holiday: h })
  })

  it('merges two holidays with the same observedDate into one group', () => {
    const h1 = makeHoliday('us-federal:a', '2026-12-25')
    const h2 = makeHoliday('us-federal:b', '2026-12-25')
    const groups = holidaysToGroups([h1, h2], today)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.items).toHaveLength(2)
  })

  it('produces separate groups for holidays on different dates', () => {
    const h1 = makeHoliday('us-federal:labor', '2026-09-07')
    const h2 = makeHoliday('us-federal:independence', '2026-07-03')
    const groups = holidaysToGroups([h1, h2], today)
    expect(groups).toHaveLength(2)
    const ymds = groups.map((g) => g.ymd)
    expect(ymds).toContain('2026-09-07')
    expect(ymds).toContain('2026-07-03')
  })
})

describe('mergeEventsAndHolidays', () => {
  function makeHoliday(id: string, observedDate: string): HolidayDto {
    return { id, name: id, date: observedDate, observedDate }
  }

  // startAt at noon UTC so localYmd lands on the intended calendar day across
  // realistic test-runner timezones; days are spaced months apart so ordering
  // is unambiguous even if an extreme TZ shifted a date by one.
  function makeEvent(id: string, startAt: string | null): PersonalEventDto {
    return {
      id,
      name: id,
      description: null,
      startAt,
      endAt: null,
      allDay: false,
      timezone: 'UTC',
      locationLabel: null,
      ticketCount: 0,
      ticketPlatform: null,
      ticketAccountEmail: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
  }

  function ids(rows: ReturnType<typeof mergeEventsAndHolidays>): string[] {
    return rows.map((r) => (r.kind === 'event' ? r.event.id : r.holiday.id))
  }

  it('returns [] for empty inputs', () => {
    expect(mergeEventsAndHolidays([], [])).toEqual([])
  })

  it('interleaves events and holidays in ascending calendar-day order', () => {
    const rows = mergeEventsAndHolidays(
      [makeEvent('ev-mar', '2026-03-10T12:00:00.000Z'), makeEvent('ev-sep', '2026-09-10T12:00:00.000Z')],
      [makeHoliday('hol-jun', '2026-06-19'), makeHoliday('hol-dec', '2026-12-25')],
    )
    expect(ids(rows)).toEqual(['ev-mar', 'hol-jun', 'ev-sep', 'hol-dec'])
  })

  it('orders events before holidays that fall on the same day', () => {
    const rows = mergeEventsAndHolidays(
      [makeEvent('ev', '2026-07-04T12:00:00.000Z')],
      [makeHoliday('hol', '2026-07-04')],
    )
    expect(ids(rows)).toEqual(['ev', 'hol'])
  })

  it('places undated events at the end, preserving their incoming order', () => {
    const rows = mergeEventsAndHolidays(
      [
        makeEvent('ev-dated', '2026-05-01T12:00:00.000Z'),
        makeEvent('ev-undated-1', null),
        makeEvent('ev-undated-2', null),
      ],
      [makeHoliday('hol', '2026-06-19')],
    )
    expect(ids(rows)).toEqual(['ev-dated', 'hol', 'ev-undated-1', 'ev-undated-2'])
  })

  it('keeps the incoming relative order of same-day events (stable)', () => {
    const rows = mergeEventsAndHolidays(
      [makeEvent('first', '2026-08-15T12:00:00.000Z'), makeEvent('second', '2026-08-15T12:00:00.000Z')],
      [],
    )
    expect(ids(rows)).toEqual(['first', 'second'])
  })

  it('handles holidays-only and events-only inputs', () => {
    expect(ids(mergeEventsAndHolidays([], [makeHoliday('h', '2026-06-19')]))).toEqual(['h'])
    expect(ids(mergeEventsAndHolidays([makeEvent('e', '2026-06-19T12:00:00.000Z')], []))).toEqual(['e'])
  })
})

describe('holidaysOnDay', () => {
  function makeHoliday(id: string, observedDate: string): HolidayDto {
    return { id, name: id, date: observedDate, observedDate }
  }

  it('returns [] when no holiday falls on the day', () => {
    expect(holidaysOnDay([makeHoliday('a', '2026-07-04')], '2026-07-03')).toEqual([])
  })

  it('returns only the holidays whose observedDate matches the day', () => {
    const a = makeHoliday('a', '2026-07-04')
    const b = makeHoliday('b', '2026-07-04')
    const c = makeHoliday('c', '2026-12-25')
    expect(holidaysOnDay([a, b, c], '2026-07-04')).toEqual([a, b])
  })

  it('matches on observedDate, not the canonical date', () => {
    // Independence Day 2026 (Sat Jul 4) observed Fri Jul 3.
    const shifted: HolidayDto = {
      id: 'us-federal:independence',
      name: 'Independence Day',
      date: '2026-07-04',
      observedDate: '2026-07-03',
    }
    expect(holidaysOnDay([shifted], '2026-07-03')).toEqual([shifted])
    expect(holidaysOnDay([shifted], '2026-07-04')).toEqual([])
  })
})

describe('upcomingFeedGroups', () => {
  const today = '2026-06-17'

  function makeHoliday(id: string, observedDate: string): HolidayDto {
    return { id, name: id, date: observedDate, observedDate }
  }

  // Noon UTC so localYmd lands on the intended day across realistic runner TZs.
  function taskItem(id: string, dueDate: string): UpcomingItem {
    return {
      kind: 'task',
      task: {
        id,
        listId: 'list-1',
        title: id,
        completed: false,
        priority: null,
        dueDate,
        seriesId: null,
        customFields: {},
      },
    }
  }

  it('returns [] for empty inputs', () => {
    expect(upcomingFeedGroups([], [], today)).toEqual([])
  })

  it('drops today and past days, keeping only strictly-future groups', () => {
    const groups = upcomingFeedGroups(
      [taskItem('today-task', '2026-06-17T12:00:00.000Z')],
      [makeHoliday('today-hol', '2026-06-17')],
      today,
    )
    expect(groups).toEqual([])
  })

  it('surfaces a future holiday as its own day-group', () => {
    const groups = upcomingFeedGroups([], [makeHoliday('hol-jul', '2026-07-03')], today)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.ymd).toBe('2026-07-03')
    expect(groups[0]!.items).toEqual([{ kind: 'holiday', holiday: makeHoliday('hol-jul', '2026-07-03') }])
  })

  it('orders holidays after a future day’s tasks/events on the same day', () => {
    const groups = upcomingFeedGroups(
      [taskItem('t', '2026-07-03T12:00:00.000Z')],
      [makeHoliday('h', '2026-07-03')],
      today,
    )
    expect(groups).toHaveLength(1)
    const kinds = groups[0]!.items.map((i) => i.kind)
    expect(kinds).toEqual(['task', 'holiday'])
  })

  it('keeps future day-groups in ascending date order', () => {
    const groups = upcomingFeedGroups(
      [taskItem('t-aug', '2026-08-10T12:00:00.000Z')],
      [makeHoliday('h-jul', '2026-07-03'), makeHoliday('h-sep', '2026-09-07')],
      today,
    )
    expect(groups.map((g) => g.ymd)).toEqual(['2026-07-03', '2026-08-10', '2026-09-07'])
  })

  function eventItem(id: string, startAt: string, endAt: string | null): UpcomingItem {
    return {
      kind: 'event',
      event: {
        id,
        name: id,
        startAt,
        endAt,
        allDay: false,
        locationLabel: null,
        ticketCount: 0,
        ticketPlatform: null,
        ticketAccountEmail: null,
      },
    }
  }

  it('places a multi-day event under each future day it spans', () => {
    // A timed 3-day event Jul 2 → Jul 4; all three days are future vs today.
    const groups = upcomingFeedGroups(
      [eventItem('trip', '2026-07-02T09:00:00.000Z', '2026-07-04T17:00:00.000Z')],
      [],
      today,
    )
    expect(groups.map((g) => g.ymd)).toEqual(['2026-07-02', '2026-07-03', '2026-07-04'])
    for (const g of groups) {
      expect(g.items.map((i) => i.kind === 'event' && i.event.id)).toEqual(['trip'])
    }
  })

  it('shows the remaining days of an event already underway (start day dropped as past/today)', () => {
    // Started two days before "today" (2026-06-17), runs through 2026-06-19.
    // The feed keeps only the strictly-future remainder (the 18th and 19th).
    const groups = upcomingFeedGroups(
      [eventItem('ongoing', '2026-06-15T09:00:00.000Z', '2026-06-19T17:00:00.000Z')],
      [],
      today,
    )
    expect(groups.map((g) => g.ymd)).toEqual(['2026-06-18', '2026-06-19'])
  })

  it('drops a timed event that ends exactly at today’s midnight (half-open, no future day)', () => {
    // 8pm Jun 15 → midnight Jun 17 occupies only Jun 15–16 (half-open end); both
    // are past "today" (Jun 17), so the feed shows nothing. This is the edge the
    // BFF over-includes (endEff >= fromMs) but the client safely discards.
    const groups = upcomingFeedGroups(
      [eventItem('ends-at-midnight', '2026-06-15T20:00:00.000Z', '2026-06-17T00:00:00.000Z')],
      [],
      today,
    )
    expect(groups).toEqual([])
  })
})
