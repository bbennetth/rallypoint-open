import { describe, it, expect } from 'vitest'
import type { ListItemDto } from '@rallypoint/lists-client'
import type { PersonalEventDto, UserEventDto } from '@rallypoint/events-client'
import { composeUpcoming, type UpcomingItem } from './upcoming.js'

// Start of the local day for all cases below: 2026-06-03T00:00Z.
const FROM = '2026-06-03T00:00:00.000Z'

function task(over: Partial<ListItemDto> & { id: string }): ListItemDto {
  return {
    listId: 'list_1',
    title: 'Task',
    notes: null,
    assignedTo: null,
    completed: false,
    completedAt: null,
    status: null,
    priority: null,
    dueDate: null,
    seriesId: null,
    position: 0,
    customFields: {},
    createdBy: 'user_a',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  }
}

function event(over: Partial<PersonalEventDto> & { id: string }): PersonalEventDto {
  return {
    scopeType: 'personal',
    ownerUserId: 'user_a',
    slug: 'e',
    name: 'Event',
    description: null,
    startAt: null,
    endAt: null,
    timezone: 'UTC',
    locationLabel: null,
    privacyMode: 'private',
    ticketCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  }
}

function userEvent(over: Partial<UserEventDto> & { eventId: string }): UserEventDto {
  return {
    slug: 'fest',
    name: 'Festival',
    scopeType: 'group',
    owned: false,
    startDate: null,
    endDate: null,
    days: [],
    ...over,
  }
}

// A stable id for each item kind. eventDays are identified by event + date so
// the per-day expansion is observable.
function ids(items: UpcomingItem[]): string[] {
  return items.map((i) => {
    if (i.kind === 'task') return i.task.id
    if (i.kind === 'event') return i.event.id
    return `${i.eventDay.eventId}@${i.eventDay.date}`
  })
}

describe('composeUpcoming', () => {
  it('buckets dated (>= start of today) vs undated, dropping the past', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [
        task({ id: 't-undated', dueDate: null }),
        task({ id: 't-past', dueDate: '2026-06-02T23:59:59.999Z' }),
        task({ id: 't-today', dueDate: '2026-06-03T09:00:00.000Z' }),
        task({ id: 't-future', dueDate: '2026-06-10T09:00:00.000Z' }),
      ],
      events: [
        event({ id: 'e-undated', startAt: null }),
        event({ id: 'e-future', startAt: '2026-06-05T08:00:00.000Z' }),
      ],
      userEvents: [],
    })
    expect(ids(out.dated)).toEqual(['t-today', 'e-future', 't-future'])
    expect(ids(out.undated).sort()).toEqual(['e-undated', 't-undated'])
  })

  it('keeps a multi-day event already underway (started before today, still running)', () => {
    // The event started Jun 1 but runs through Jun 5 — it still has days to show
    // in the forward feed, so it is NOT dropped as "past" the way a point event
    // with a past startAt would be. The client expands it across its days.
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [],
      events: [event({ id: 'ongoing', startAt: '2026-06-01T09:00:00.000Z', endAt: '2026-06-05T17:00:00.000Z' })],
      userEvents: [],
    })
    expect(ids(out.dated)).toEqual(['ongoing'])
  })

  it('drops an event that ended entirely in the past', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [],
      events: [event({ id: 'done', startAt: '2026-06-01T09:00:00.000Z', endAt: '2026-06-02T17:00:00.000Z' })],
      userEvents: [],
    })
    expect(out.dated).toEqual([])
    expect(out.undated).toEqual([])
  })

  it('keeps an all-day event reaching its inclusive last day (endAt = window start day)', () => {
    // All-day end is local midnight of the last covered day; +DAY_MS in
    // eventReachesForward keeps that final day in range. Querying the start of
    // 2026-06-04 (FROM_JUN4), a conference 06-02 → 06-04 still has the 4th to show.
    const FROM_JUN4 = '2026-06-04T00:00:00.000Z'
    const out = composeUpcoming({
      date: '2026-06-04',
      timezone: 'UTC',
      fromInstant: FROM_JUN4,
      tasks: [],
      events: [
        event({ id: 'conf', allDay: true, startAt: '2026-06-02T00:00:00.000Z', endAt: '2026-06-04T00:00:00.000Z' }),
      ],
      userEvents: [],
    })
    expect(ids(out.dated)).toEqual(['conf'])
  })

  it('includes today (start instant is inclusive — half-open lower bound)', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [task({ id: 'at-start', dueDate: '2026-06-03T00:00:00.000Z' })],
      events: [],
      userEvents: [],
    })
    expect(ids(out.dated)).toEqual(['at-start'])
  })

  it('merges tasks and events into one date-sorted stream', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [
        task({ id: 't-jun7', dueDate: '2026-06-07T12:00:00.000Z' }),
        task({ id: 't-jun4', dueDate: '2026-06-04T12:00:00.000Z' }),
      ],
      events: [event({ id: 'e-jun5', startAt: '2026-06-05T12:00:00.000Z' })],
      userEvents: [],
    })
    expect(ids(out.dated)).toEqual(['t-jun4', 'e-jun5', 't-jun7'])
  })

  it('breaks dated ties by label (title/name)', () => {
    const SAME = '2026-06-04T09:00:00.000Z'
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [task({ id: 't-z', title: 'Zebra', dueDate: SAME })],
      events: [event({ id: 'e-a', name: 'Apple', startAt: SAME })],
      userEvents: [],
    })
    expect(ids(out.dated)).toEqual(['e-a', 't-z'])
  })

  it('orders undated by createdAt then label', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [
        task({ id: 'newer', title: 'B', createdAt: '2026-06-02T00:00:00.000Z' }),
        task({ id: 'older', title: 'A', createdAt: '2026-06-01T00:00:00.000Z' }),
      ],
      events: [event({ id: 'mid', name: 'M', createdAt: '2026-06-01T12:00:00.000Z' })],
      userEvents: [],
    })
    expect(ids(out.undated)).toEqual(['older', 'mid', 'newer'])
  })

  it('echoes date + timezone', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'America/Chicago',
      fromInstant: FROM,
      tasks: [],
      events: [],
      userEvents: [],
    })
    expect(out).toMatchObject({ date: '2026-06-03', timezone: 'America/Chicago' })
    expect(out.dated).toEqual([])
    expect(out.undated).toEqual([])
  })

  // --- group (festival) events: per-day expansion ----------------------

  it('expands one group event into one dated item per day', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [],
      events: [],
      userEvents: [
        userEvent({
          eventId: 'event_fest',
          days: [
            { date: '2026-06-04', dayLabel: 'Day 1', startTime: '10:00', endTime: '18:00' },
            { date: '2026-06-05', dayLabel: 'Day 2', startTime: null, endTime: null },
          ],
        }),
      ],
    })
    expect(ids(out.dated)).toEqual(['event_fest@2026-06-04', 'event_fest@2026-06-05'])
    expect(out.undated).toEqual([])
  })

  it('drops a group event day that falls before the window start', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [],
      events: [],
      userEvents: [
        userEvent({
          eventId: 'event_past',
          days: [
            { date: '2026-06-01', dayLabel: 'Past', startTime: null, endTime: null },
            { date: '2026-06-07', dayLabel: 'Future', startTime: null, endTime: null },
          ],
        }),
      ],
    })
    expect(ids(out.dated)).toEqual(['event_past@2026-06-07'])
  })

  it('all-day group day sorts above a timed item sharing the same instant', () => {
    // All-day day buckets to local midnight (2026-06-04T00:00Z); a task due at
    // the same instant must sort below it.
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [task({ id: 't-midnight', dueDate: '2026-06-04T00:00:00.000Z' })],
      events: [],
      userEvents: [
        userEvent({
          eventId: 'event_allday',
          days: [{ date: '2026-06-04', dayLabel: 'All', startTime: null, endTime: null }],
        }),
      ],
    })
    expect(ids(out.dated)).toEqual(['event_allday@2026-06-04', 't-midnight'])
  })

  it('a timed group day buckets at its start time', () => {
    // 09:00 on Jun 4 sorts after a task due at 08:00 the same day.
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [task({ id: 't-8am', dueDate: '2026-06-04T08:00:00.000Z' })],
      events: [],
      userEvents: [
        userEvent({
          eventId: 'event_timed',
          days: [{ date: '2026-06-04', dayLabel: 'Day', startTime: '09:00', endTime: '17:00' }],
        }),
      ],
    })
    expect(ids(out.dated)).toEqual(['t-8am', 'event_timed@2026-06-04'])
  })

  it('floats an all-day group day above a personal event at the same midnight instant', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [],
      events: [event({ id: 'e-midnight', name: 'Midnight', startAt: '2026-06-04T00:00:00.000Z' })],
      userEvents: [
        userEvent({
          eventId: 'event_allday',
          days: [{ date: '2026-06-04', dayLabel: 'All', startTime: null, endTime: null }],
        }),
      ],
    })
    expect(ids(out.dated)).toEqual(['event_allday@2026-06-04', 'e-midnight'])
  })

  it('carries the server-stamped owned flag through unchanged', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [],
      events: [],
      userEvents: [
        userEvent({
          eventId: 'event_owned',
          owned: true,
          days: [{ date: '2026-06-04', dayLabel: 'Day', startTime: null, endTime: null }],
        }),
      ],
    })
    const item = out.dated.find((i) => i.kind === 'eventDay')
    expect(item?.kind).toBe('eventDay')
    if (item?.kind === 'eventDay') expect(item.eventDay.owned).toBe(true)
  })
})

// ── recurring-series occurrence cap ─────────────────────────────────────────

describe('capSeriesOccurrences (via composeUpcoming)', () => {
  const dueOn = (day: string) => `2026-06-${day}T12:00:00.000Z`

  it('limits one series to its next 2 occurrences, soonest kept', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [
        task({ id: 't3', seriesId: 'srs_a', dueDate: dueOn('10') }),
        task({ id: 't1', seriesId: 'srs_a', dueDate: dueOn('04') }),
        task({ id: 't2', seriesId: 'srs_a', dueDate: dueOn('07') }),
      ],
      events: [],
      userEvents: [],
    })
    expect(ids(out.dated)).toEqual(['t1', 't2'])
  })

  it('caps each series independently and leaves non-series items alone', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [
        task({ id: 'a1', seriesId: 'srs_a', dueDate: dueOn('04') }),
        task({ id: 'a2', seriesId: 'srs_a', dueDate: dueOn('05') }),
        task({ id: 'a3', seriesId: 'srs_a', dueDate: dueOn('06') }),
        task({ id: 'b1', seriesId: 'srs_b', dueDate: dueOn('04') }),
        task({ id: 'b2', seriesId: 'srs_b', dueDate: dueOn('05') }),
        task({ id: 'b3', seriesId: 'srs_b', dueDate: dueOn('06') }),
        task({ id: 'oneoff', dueDate: dueOn('20') }),
      ],
      events: [],
      userEvents: [],
    })
    expect(ids(out.dated)).toEqual(['a1', 'b1', 'a2', 'b2', 'oneoff'])
  })

  it('past occurrences do not consume the cap (already dropped by the window)', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [
        task({ id: 'past', seriesId: 'srs_a', dueDate: '2026-06-01T12:00:00.000Z' }),
        task({ id: 'n1', seriesId: 'srs_a', dueDate: dueOn('04') }),
        task({ id: 'n2', seriesId: 'srs_a', dueDate: dueOn('05') }),
      ],
      events: [],
      userEvents: [],
    })
    expect(ids(out.dated)).toEqual(['n1', 'n2'])
  })

  it('series with 2 or fewer occurrences are unaffected; undated never capped', () => {
    const out = composeUpcoming({
      date: '2026-06-03',
      timezone: 'UTC',
      fromInstant: FROM,
      tasks: [
        task({ id: 's1', seriesId: 'srs_a', dueDate: dueOn('04') }),
        task({ id: 'u1', seriesId: 'srs_a' }), // no dueDate → undated bucket
        task({ id: 'u2', seriesId: 'srs_a' }),
        task({ id: 'u3', seriesId: 'srs_a' }),
      ],
      events: [],
      userEvents: [],
    })
    expect(ids(out.dated)).toEqual(['s1'])
    expect(out.undated.length).toBe(3)
  })
})
