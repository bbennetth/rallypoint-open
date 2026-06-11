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
