import { describe, it, expect } from 'vitest'
import type { ListItemDto } from '@rallypoint/lists-client'
import type { PersonalEventDto, UserEventDto } from '@rallypoint/events-client'
import { composeMyDay } from './my-day.js'

// A UTC window covering all of 2026-06-03.
const WINDOW = { start: '2026-06-03T00:00:00.000Z', end: '2026-06-04T00:00:00.000Z' }

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

describe('composeMyDay', () => {
  it('keeps only tasks whose dueDate is within the window', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({ id: 'undated', dueDate: null }),
        task({ id: 'yesterday', dueDate: '2026-06-02T23:59:59.999Z' }),
        task({ id: 'today', dueDate: '2026-06-03T09:00:00.000Z' }),
        task({ id: 'tomorrow', dueDate: '2026-06-04T00:00:00.000Z' }),
      ],
      events: [],
      userEvents: [],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['today'])
    // undated task must not appear in dated tasks bucket
    expect(out.tasks.find((t) => t.id === 'undated')).toBeUndefined()
  })

  it('treats the window as half-open [start, end)', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({ id: 'at-start', dueDate: '2026-06-03T00:00:00.000Z' }),
        task({ id: 'at-end', dueDate: '2026-06-04T00:00:00.000Z' }),
      ],
      events: [],
      userEvents: [],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['at-start'])
  })

  it('sorts tasks by due time then title', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({ id: 'late', title: 'Z', dueDate: '2026-06-03T18:00:00.000Z' }),
        task({ id: 'early-b', title: 'B', dueDate: '2026-06-03T09:00:00.000Z' }),
        task({ id: 'early-a', title: 'A', dueDate: '2026-06-03T09:00:00.000Z' }),
      ],
      events: [],
      userEvents: [],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['early-a', 'early-b', 'late'])
  })

  it('keeps and sorts events whose startAt is within the window; drops undated', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [],
      events: [
        event({ id: 'undated', startAt: null }),
        event({ id: 'evening', startAt: '2026-06-03T20:00:00.000Z' }),
        event({ id: 'morning', startAt: '2026-06-03T08:00:00.000Z' }),
        event({ id: 'next-day', startAt: '2026-06-04T08:00:00.000Z' }),
      ],
      userEvents: [],
    })
    expect(out.events.map((e) => e.id)).toEqual(['morning', 'evening'])
  })

  it('includes completed tasks (display state is the UI’s concern)', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [task({ id: 'done', completed: true, dueDate: '2026-06-03T09:00:00.000Z' })],
      events: [],
      userEvents: [],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['done'])
  })

  it('echoes date + timezone', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'America/Chicago',
      window: WINDOW,
      tasks: [],
      events: [],
      userEvents: [],
    })
    expect(out).toMatchObject({ date: '2026-06-03', timezone: 'America/Chicago' })
  })

  // --- group (festival) event days -------------------------------------

  it('keeps only the group event days that fall inside the window', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [],
      events: [],
      userEvents: [
        userEvent({
          eventId: 'event_fest',
          days: [
            { date: '2026-06-02', dayLabel: 'Before', startTime: null, endTime: null },
            { date: '2026-06-03', dayLabel: 'Today', startTime: '10:00', endTime: '18:00' },
            { date: '2026-06-04', dayLabel: 'After', startTime: null, endTime: null },
          ],
        }),
      ],
    })
    expect(out.eventDays.map((d) => d.date)).toEqual(['2026-06-03'])
  })

  it('sorts all-day group days above timed days sharing the same instant', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [],
      events: [],
      userEvents: [
        // A timed day at local midnight and an all-day day land on the same
        // instant (start of day); the all-day one must come first.
        userEvent({
          eventId: 'event_timed',
          name: 'Timed',
          days: [{ date: '2026-06-03', dayLabel: 'Day', startTime: '00:00', endTime: '02:00' }],
        }),
        userEvent({
          eventId: 'event_allday',
          name: 'AllDay',
          days: [{ date: '2026-06-03', dayLabel: 'Day', startTime: null, endTime: null }],
        }),
      ],
    })
    expect(out.eventDays.map((d) => d.eventId)).toEqual(['event_allday', 'event_timed'])
  })

  it('carries the server-stamped owned flag through unchanged', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [],
      events: [],
      userEvents: [
        userEvent({
          eventId: 'event_owned',
          owned: true,
          days: [{ date: '2026-06-03', dayLabel: 'Day', startTime: null, endTime: null }],
        }),
      ],
    })
    expect(out.eventDays).toHaveLength(1)
    expect(out.eventDays[0]?.owned).toBe(true)
  })

  // --- undated tasks ---------------------------------------------------

  it('routes undated tasks into undatedTasks, not tasks', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({ id: 'dated', dueDate: '2026-06-03T09:00:00.000Z' }),
        task({ id: 'undated-a', dueDate: null }),
        task({ id: 'undated-b', dueDate: null }),
      ],
      events: [],
      userEvents: [],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['dated'])
    expect(out.undatedTasks.map((t) => t.id).sort()).toEqual(['undated-a', 'undated-b'])
  })

  it('includes incomplete undated tasks regardless of completion state', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [task({ id: 'open-undated', dueDate: null, completed: false })],
      events: [],
      userEvents: [],
    })
    expect(out.undatedTasks.map((t) => t.id)).toEqual(['open-undated'])
  })

  it('includes completed undated task whose completedAt falls inside the window', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({
          id: 'done-today',
          dueDate: null,
          completed: true,
          completedAt: '2026-06-03T14:00:00.000Z',
        }),
      ],
      events: [],
      userEvents: [],
    })
    expect(out.undatedTasks.map((t) => t.id)).toEqual(['done-today'])
  })

  it('excludes completed undated task whose completedAt is before the window', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({
          id: 'done-yesterday',
          dueDate: null,
          completed: true,
          completedAt: '2026-06-02T20:00:00.000Z',
        }),
      ],
      events: [],
      userEvents: [],
    })
    expect(out.undatedTasks).toHaveLength(0)
  })

  it('excludes completed undated task with null completedAt', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({ id: 'done-no-ts', dueDate: null, completed: true, completedAt: null }),
      ],
      events: [],
      userEvents: [],
    })
    expect(out.undatedTasks).toHaveLength(0)
  })

  it('sorts undatedTasks by priority (high first) then title', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({ id: 'low-z', title: 'Z', dueDate: null, priority: 'low' }),
        task({ id: 'medium-b', title: 'B', dueDate: null, priority: 'medium' }),
        task({ id: 'high-a', title: 'A', dueDate: null, priority: 'high' }),
        task({ id: 'none', title: 'N', dueDate: null, priority: null }),
        task({ id: 'high-h', title: 'H', dueDate: null, priority: 'high' }),
      ],
      events: [],
      userEvents: [],
    })
    // Expected order: high (A) → high (H) → medium (B) → low (Z) → none (N)
    expect(out.undatedTasks.map((t) => t.id)).toEqual([
      'high-a',
      'high-h',
      'medium-b',
      'low-z',
      'none',
    ])
    // Null/no-priority must sort last.
    expect(out.undatedTasks[out.undatedTasks.length - 1]?.priority).toBeNull()
  })

  it('all-undated input: tasks is empty, undatedTasks has everything', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({ id: 'u1', dueDate: null }),
        task({ id: 'u2', dueDate: null }),
      ],
      events: [],
      userEvents: [],
    })
    expect(out.tasks).toHaveLength(0)
    expect(out.undatedTasks).toHaveLength(2)
  })

  it('all-dated input: undatedTasks is empty', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({ id: 'd1', dueDate: '2026-06-03T08:00:00.000Z' }),
        task({ id: 'd2', dueDate: '2026-06-03T12:00:00.000Z' }),
      ],
      events: [],
      userEvents: [],
    })
    expect(out.tasks).toHaveLength(2)
    expect(out.undatedTasks).toHaveLength(0)
  })
})
