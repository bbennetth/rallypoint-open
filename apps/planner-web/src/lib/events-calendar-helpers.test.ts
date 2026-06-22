// Unit tests for events-calendar-helpers.ts — personalEventsToGroups pure fn.
// Run with: npm run test:d1 (planner suite uses vitest-pool-workers)
// These are pure-function tests with no DB access; vitest resolves them without
// workerd, but they live in the planner-web vitest workspace alongside the
// other planner-helpers tests.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  eventSpanYmds,
  MAX_EVENT_SPAN_DAYS,
  personalEventsToGroups,
  resolveCalendarDetail,
} from './events-calendar-helpers.js'
import type { HolidayDto, PersonalEventDto, UpcomingItem } from './api.js'

function makeEvent(overrides: Partial<PersonalEventDto> & { id: string }): PersonalEventDto {
  return {
    id: overrides.id,
    name: overrides.name ?? 'Test Event',
    description: null,
    startAt: overrides.startAt ?? null,
    endAt: overrides.endAt ?? null,
    allDay: overrides.allDay ?? false,
    timezone: 'UTC',
    locationLabel: null,
    ticketCount: 0,
    ticketPlatform: null,
    ticketAccountEmail: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

const TODAY = '2026-06-12'

describe('personalEventsToGroups', () => {
  // The Planner date helpers bucket events by the *runtime* timezone — in the
  // browser that is the user's own zone (no stored per-user tz; see
  // planner-helpers.ts). These fixtures are authored in UTC, so pin the runtime
  // zone to UTC to keep the assertions deterministic on any host. CI runs in
  // UTC, but a dev box in e.g. America/Los_Angeles would otherwise bucket the
  // boundary/all-day fixtures a day earlier. The negative-offset behaviour the
  // UTC pin can't observe is covered in the suite below.
  const ORIG_TZ = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'UTC'
  })
  afterAll(() => {
    if (ORIG_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIG_TZ
  })

  it('returns empty array for no events', () => {
    expect(personalEventsToGroups([], TODAY)).toEqual([])
  })

  it('excludes events with no startAt', () => {
    const events = [
      makeEvent({ id: 'e1', startAt: null }),
      makeEvent({ id: 'e2', startAt: null }),
    ]
    expect(personalEventsToGroups(events, TODAY)).toEqual([])
  })

  it('buckets a single timed event into its local day', () => {
    // 2026-06-15 at noon UTC → local day is 2026-06-15 (UTC test env)
    const events = [makeEvent({ id: 'e1', startAt: '2026-06-15T12:00:00.000Z', allDay: false })]
    const groups = personalEventsToGroups(events, TODAY)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.ymd).toBe('2026-06-15')
    expect(groups[0]?.items).toHaveLength(1)
    expect(groups[0]?.items[0]?.kind).toBe('event')
  })

  it('groups two events on the same day into one cell', () => {
    const events = [
      makeEvent({ id: 'e1', startAt: '2026-06-15T10:00:00.000Z' }),
      makeEvent({ id: 'e2', startAt: '2026-06-15T14:00:00.000Z' }),
    ]
    const groups = personalEventsToGroups(events, TODAY)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.items).toHaveLength(2)
  })

  it('produces separate groups for events on different days', () => {
    const events = [
      makeEvent({ id: 'e1', startAt: '2026-06-14T12:00:00.000Z' }),
      makeEvent({ id: 'e2', startAt: '2026-06-15T12:00:00.000Z' }),
      makeEvent({ id: 'e3', startAt: '2026-06-20T12:00:00.000Z' }),
    ]
    const groups = personalEventsToGroups(events, TODAY)
    expect(groups).toHaveLength(3)
    expect(groups.map((g) => g.ymd)).toEqual(['2026-06-14', '2026-06-15', '2026-06-20'])
  })

  it('handles month-boundary events correctly (Jun 30 vs Jul 1)', () => {
    const events = [
      makeEvent({ id: 'e1', startAt: '2026-06-30T23:00:00.000Z' }), // Jun 30 UTC
      makeEvent({ id: 'e2', startAt: '2026-07-01T01:00:00.000Z' }), // Jul 1 UTC
    ]
    const groups = personalEventsToGroups(events, TODAY)
    // In UTC both map to different days: Jun 30 and Jul 1
    expect(groups).toHaveLength(2)
    expect(groups[0]?.ymd).toBe('2026-06-30')
    expect(groups[1]?.ymd).toBe('2026-07-01')
  })

  it('treats an all-day event (allDay=true) correctly — still bucketed by startAt day', () => {
    const events = [
      makeEvent({ id: 'e1', startAt: '2026-06-20T00:00:00.000Z', allDay: true }),
    ]
    const groups = personalEventsToGroups(events, TODAY)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.ymd).toBe('2026-06-20')
    expect(groups[0]?.items[0]).toMatchObject({ kind: 'event' })
    // The adapted item carries the allDay flag through
    if (groups[0]?.items[0]?.kind === 'event') {
      expect(groups[0].items[0].event.allDay).toBe(true)
    }
  })

  it('mixes dated and undated events: undated are excluded', () => {
    const events = [
      makeEvent({ id: 'e1', startAt: '2026-06-15T12:00:00.000Z' }),
      makeEvent({ id: 'e2', startAt: null }), // excluded
      makeEvent({ id: 'e3', startAt: '2026-06-16T09:00:00.000Z' }),
    ]
    const groups = personalEventsToGroups(events, TODAY)
    expect(groups).toHaveLength(2)
    expect(groups.flatMap((g) => g.items).map((it) => it.kind === 'event' && it.event.id)).toEqual([
      'e1',
      'e3',
    ])
  })

  it('preserves event name through the adapter', () => {
    const events = [makeEvent({ id: 'e1', name: 'Concert Night', startAt: '2026-06-15T19:00:00.000Z' })]
    const groups = personalEventsToGroups(events, TODAY)
    const item = groups[0]?.items[0]
    expect(item?.kind === 'event' && item.event.name).toBe('Concert Night')
  })

  it('produces relative label "Today" for an event on todayYmd', () => {
    const events = [makeEvent({ id: 'e1', startAt: '2026-06-12T10:00:00.000Z' })]
    const groups = personalEventsToGroups(events, TODAY)
    expect(groups[0]?.rel).toBe('Today')
  })

  it('produces relative label "Tomorrow" for an event one day ahead', () => {
    const events = [makeEvent({ id: 'e1', startAt: '2026-06-13T10:00:00.000Z' })]
    const groups = personalEventsToGroups(events, TODAY)
    expect(groups[0]?.rel).toBe('Tomorrow')
  })
})

// Same helper, pinned to a negative-UTC-offset zone (America/Los_Angeles, UTC-7
// in summer) to prove the bucketing follows the user's *local* day — the
// intended product behaviour, matching My Day / Upcoming, which group with the
// same localYmd — rather than UTC. These are the cases the UTC-pinned suite
// above can't observe; the per-describe TZ pin mirrors the regression tests in
// planner-helpers.test.ts.
describe('personalEventsToGroups — local-zone bucketing (negative UTC offset)', () => {
  const ORIG_TZ = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  afterAll(() => {
    if (ORIG_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIG_TZ
  })

  it('collapses two events straddling UTC midnight into one local day', () => {
    // 2026-06-30T23:00Z = 16:00 Jun 30 PDT and 2026-07-01T01:00Z = 18:00 Jun 30
    // PDT — both fall on the user's local Jun 30, so they share one cell (unlike
    // the UTC view, where they would be two separate days).
    const events = [
      makeEvent({ id: 'e1', startAt: '2026-06-30T23:00:00.000Z' }),
      makeEvent({ id: 'e2', startAt: '2026-07-01T01:00:00.000Z' }),
    ]
    const groups = personalEventsToGroups(events, '2026-06-30')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.ymd).toBe('2026-06-30')
    expect(groups[0]?.items).toHaveLength(2)
  })

  it('rolls an early-UTC event back onto the prior local day', () => {
    // 2026-06-15T05:00Z = 22:00 Jun 14 PDT → the user sees it on Jun 14, not 15.
    const events = [makeEvent({ id: 'e1', startAt: '2026-06-15T05:00:00.000Z' })]
    const groups = personalEventsToGroups(events, '2026-06-14')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.ymd).toBe('2026-06-14')
  })
})

describe('eventSpanYmds', () => {
  const ORIG_TZ = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'UTC'
  })
  afterAll(() => {
    if (ORIG_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIG_TZ
  })

  it('returns [] for an event with no startAt', () => {
    expect(eventSpanYmds({ startAt: null, endAt: '2026-06-17T00:00:00.000Z', allDay: true })).toEqual([])
  })

  it('returns just the start day when there is no endAt', () => {
    expect(eventSpanYmds({ startAt: '2026-06-15T12:00:00.000Z', endAt: null, allDay: false })).toEqual([
      '2026-06-15',
    ])
  })

  it('collapses a backwards range (end <= start) to the start day', () => {
    expect(
      eventSpanYmds({ startAt: '2026-06-15T12:00:00.000Z', endAt: '2026-06-14T12:00:00.000Z', allDay: false }),
    ).toEqual(['2026-06-15'])
  })

  it('lists every day of a timed multi-day event, inclusive of the end day', () => {
    expect(
      eventSpanYmds({ startAt: '2026-06-15T09:00:00.000Z', endAt: '2026-06-17T17:00:00.000Z', allDay: false }),
    ).toEqual(['2026-06-15', '2026-06-16', '2026-06-17'])
  })

  it('drops a timed event’s final day when it ends exactly at local midnight (half-open)', () => {
    // 8pm Jun 15 → midnight Jun 16 occupies only Jun 15.
    expect(
      eventSpanYmds({ startAt: '2026-06-15T20:00:00.000Z', endAt: '2026-06-16T00:00:00.000Z', allDay: false }),
    ).toEqual(['2026-06-15'])
  })

  it('keeps the final day for a timed event ending just after midnight', () => {
    expect(
      eventSpanYmds({ startAt: '2026-06-15T20:00:00.000Z', endAt: '2026-06-16T00:01:00.000Z', allDay: false }),
    ).toEqual(['2026-06-15', '2026-06-16'])
  })

  it('treats an all-day event’s endAt as the inclusive last day', () => {
    // All-day editor stores end = local midnight of the last covered day.
    expect(
      eventSpanYmds({ startAt: '2026-06-15T00:00:00.000Z', endAt: '2026-06-17T00:00:00.000Z', allDay: true }),
    ).toEqual(['2026-06-15', '2026-06-16', '2026-06-17'])
  })

  it('caps a pathological range at MAX_EVENT_SPAN_DAYS', () => {
    const span = eventSpanYmds({
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2030-01-01T00:00:00.000Z',
      allDay: true,
    })
    expect(span).toHaveLength(MAX_EVENT_SPAN_DAYS)
    expect(span[0]).toBe('2026-01-01')
  })
})

describe('personalEventsToGroups — multi-day spanning', () => {
  const ORIG_TZ = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'UTC'
  })
  afterAll(() => {
    if (ORIG_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIG_TZ
  })

  it('places a 3-day event on each of its days', () => {
    const events = [
      makeEvent({ id: 'trip', startAt: '2026-06-15T09:00:00.000Z', endAt: '2026-06-17T17:00:00.000Z' }),
    ]
    const groups = personalEventsToGroups(events, TODAY)
    const byYmd = Object.fromEntries(groups.map((g) => [g.ymd, g]))
    expect(Object.keys(byYmd).sort()).toEqual(['2026-06-15', '2026-06-16', '2026-06-17'])
    for (const ymd of ['2026-06-15', '2026-06-16', '2026-06-17']) {
      expect(byYmd[ymd]?.items.map((it) => it.kind === 'event' && it.event.id)).toEqual(['trip'])
    }
  })

  it('merges a multi-day event with a single-day event sharing a middle day', () => {
    const events = [
      makeEvent({ id: 'trip', startAt: '2026-06-15T09:00:00.000Z', endAt: '2026-06-17T17:00:00.000Z' }),
      makeEvent({ id: 'lunch', startAt: '2026-06-16T12:00:00.000Z' }),
    ]
    const groups = personalEventsToGroups(events, TODAY)
    const mid = groups.find((g) => g.ymd === '2026-06-16')
    expect(mid?.items.map((it) => it.kind === 'event' && it.event.id).sort()).toEqual(['lunch', 'trip'])
  })
})

describe('resolveCalendarDetail', () => {
  function makeHoliday(id: string): HolidayDto {
    return { id, name: `Holiday ${id}`, date: '2026-06-19', observedDate: '2026-06-19' }
  }

  it('re-hydrates an event item to its full PersonalEventDto from the list', () => {
    const full = makeEvent({ id: 'e1', name: 'Concert', description: 'Front row', locationLabel: 'Arena' })
    const item: UpcomingItem = {
      // The calendar carries only the MyDayEvent projection (no description).
      kind: 'event',
      event: {
        id: 'e1', name: 'Concert', startAt: null, endAt: null, allDay: false,
        locationLabel: 'Arena', ticketCount: 0, ticketPlatform: null, ticketAccountEmail: null,
      },
    }
    const detail = resolveCalendarDetail(item, [makeEvent({ id: 'e0' }), full])
    expect(detail).toEqual({ kind: 'event', event: full })
    // The resolved detail is the full DTO, so description survives the lookup.
    expect(detail?.kind === 'event' && detail.event.description).toBe('Front row')
  })

  it('returns null when the event item has no matching DTO in the list', () => {
    const item: UpcomingItem = {
      kind: 'event',
      event: {
        id: 'missing', name: 'Ghost', startAt: null, endAt: null, allDay: false,
        locationLabel: null, ticketCount: 0, ticketPlatform: null, ticketAccountEmail: null,
      },
    }
    expect(resolveCalendarDetail(item, [makeEvent({ id: 'e1' })])).toBeNull()
  })

  it('passes a holiday item straight through (read-only, no list lookup)', () => {
    const holiday = makeHoliday('h1')
    expect(resolveCalendarDetail({ kind: 'holiday', holiday }, [])).toEqual({ kind: 'holiday', holiday })
  })

  it('returns null for task and eventDay items (no detail surface on the Events tab)', () => {
    const task: UpcomingItem = {
      kind: 'task',
      task: {
        id: 't1', listId: 'l1', title: 'Do thing', completed: false,
        priority: null, dueDate: null, seriesId: null, customFields: {},
      },
    }
    const eventDay: UpcomingItem = {
      kind: 'eventDay',
      eventDay: {
        eventId: 'g1', slug: 'fest', name: 'Fest', scopeType: 'group', date: '2026-06-19',
        dayLabel: 'Day 1', startTime: null, endTime: null, owned: false,
      },
    }
    expect(resolveCalendarDetail(task, [])).toBeNull()
    expect(resolveCalendarDetail(eventDay, [])).toBeNull()
  })
})
