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
    statusId: null,
    parentId: null,
    priority: null,
    dueDate: null,
    position: 0,
    customFields: {},
    seriesId: null,
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
  it('keeps in-window tasks; drops undated, future, and completed-overdue', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [
        task({ id: 'undated', dueDate: null }),
        // Overdue but completed → does NOT roll forward (it's done).
        task({ id: 'yesterday-done', dueDate: '2026-06-02T23:59:59.999Z', completed: true, completedAt: '2026-06-02T23:59:59.999Z' }),
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

  // --- multi-day events: shown on every day they span -------------------

  it('keeps a multi-day event that started before today but runs into it', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [],
      events: [
        event({ id: 'ongoing', startAt: '2026-06-02T20:00:00.000Z', endAt: '2026-06-03T10:00:00.000Z' }),
      ],
      userEvents: [],
    })
    expect(out.events.map((e) => e.id)).toEqual(['ongoing'])
  })

  it('keeps a multi-day event that starts today and ends on a later day', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [],
      events: [
        event({ id: 'trip', startAt: '2026-06-03T09:00:00.000Z', endAt: '2026-06-05T17:00:00.000Z' }),
      ],
      userEvents: [],
    })
    expect(out.events.map((e) => e.id)).toEqual(['trip'])
  })

  it('drops an event that ended entirely before today', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [],
      events: [
        event({ id: 'past', startAt: '2026-06-01T09:00:00.000Z', endAt: '2026-06-02T17:00:00.000Z' }),
      ],
      userEvents: [],
    })
    expect(out.events).toEqual([])
  })

  it('drops a timed event ending exactly at the window start (half-open)', () => {
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [],
      events: [
        event({ id: 'ended-at-midnight', startAt: '2026-06-02T20:00:00.000Z', endAt: '2026-06-03T00:00:00.000Z' }),
      ],
      userEvents: [],
    })
    expect(out.events).toEqual([])
  })

  it('keeps an all-day multi-day event on its inclusive last day', () => {
    // All-day end is local midnight of the last covered day (2026-06-04). The
    // window is 2026-06-03, which the span [06-02 .. 06-04] still covers.
    const out = composeMyDay({
      date: '2026-06-03',
      timezone: 'UTC',
      window: WINDOW,
      tasks: [],
      events: [
        event({
          id: 'conf',
          allDay: true,
          startAt: '2026-06-02T00:00:00.000Z',
          endAt: '2026-06-04T00:00:00.000Z',
        }),
      ],
      userEvents: [],
    })
    expect(out.events.map((e) => e.id)).toEqual(['conf'])
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

// Overdue roll-over: an item not completed by its due date keeps showing on
// each later day until it's done. Recurring items collapse to one row a day so
// a rolled-over occurrence never doubles up with the day's own occurrence.
describe('composeMyDay — overdue roll-over', () => {
  const base = { date: '2026-06-03', timezone: 'UTC', window: WINDOW, events: [], userEvents: [] }

  it('rolls an overdue incomplete one-off task forward into today', () => {
    const out = composeMyDay({
      ...base,
      tasks: [
        task({ id: 'today', dueDate: '2026-06-03T09:00:00.000Z' }),
        task({ id: 'overdue', dueDate: '2026-06-02T09:00:00.000Z' }),
      ],
    })
    // Overdue leads (earlier dueDate), then today's item.
    expect(out.tasks.map((t) => t.id)).toEqual(['overdue', 'today'])
  })

  it('keeps rolling a multi-day-overdue task (still shows days later)', () => {
    const out = composeMyDay({
      ...base,
      tasks: [task({ id: 'stale', dueDate: '2026-05-28T09:00:00.000Z' })],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['stale'])
  })

  it('does not roll an overdue task that was completed (late)', () => {
    const out = composeMyDay({
      ...base,
      tasks: [
        task({
          id: 'done-late',
          dueDate: '2026-06-01T09:00:00.000Z',
          completed: true,
          completedAt: '2026-06-02T09:00:00.000Z',
        }),
      ],
    })
    expect(out.tasks).toHaveLength(0)
  })

  it('does not show a recurring occurrence twice when the next one is also today', () => {
    // A daily chore: yesterday's occurrence is overdue+open, today's is due
    // today. Both share a seriesId → only today's occurrence shows.
    const out = composeMyDay({
      ...base,
      tasks: [
        task({ id: 'occ-today', seriesId: 'lse_chore', dueDate: '2026-06-03T07:00:00.000Z' }),
        task({ id: 'occ-overdue', seriesId: 'lse_chore', dueDate: '2026-06-02T07:00:00.000Z' }),
      ],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['occ-today'])
  })

  it('prefers the on-day occurrence even when it is already completed', () => {
    const out = composeMyDay({
      ...base,
      tasks: [
        task({
          id: 'occ-today-done',
          seriesId: 'lse_chore',
          dueDate: '2026-06-03T07:00:00.000Z',
          completed: true,
          completedAt: '2026-06-03T07:30:00.000Z',
        }),
        task({ id: 'occ-overdue', seriesId: 'lse_chore', dueDate: '2026-06-02T07:00:00.000Z' }),
      ],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['occ-today-done'])
  })

  it('collapses several overdue occurrences of one series to the longest-overdue', () => {
    // A daily chore missed three days running, no occurrence due today → a
    // single row stands in for the series (the earliest, longest-overdue one).
    const out = composeMyDay({
      ...base,
      tasks: [
        task({ id: 'occ-mon', seriesId: 'lse_chore', dueDate: '2026-05-31T07:00:00.000Z' }),
        task({ id: 'occ-tue', seriesId: 'lse_chore', dueDate: '2026-06-01T07:00:00.000Z' }),
        task({ id: 'occ-wed', seriesId: 'lse_chore', dueDate: '2026-06-02T07:00:00.000Z' }),
      ],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['occ-mon'])
  })

  it('shows an overdue recurring occurrence when the next occurrence is not today', () => {
    // A weekly chore overdue from last week with nothing due today → it rolls.
    const out = composeMyDay({
      ...base,
      tasks: [task({ id: 'occ-lastweek', seriesId: 'lse_weekly', dueDate: '2026-05-27T07:00:00.000Z' })],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['occ-lastweek'])
  })

  it('does not collapse distinct one-off overdue tasks (no seriesId)', () => {
    const out = composeMyDay({
      ...base,
      tasks: [
        task({ id: 'one-off-a', title: 'A', dueDate: '2026-06-02T07:00:00.000Z' }),
        task({ id: 'one-off-b', title: 'B', dueDate: '2026-06-02T07:00:00.000Z' }),
      ],
    })
    expect(out.tasks.map((t) => t.id).sort()).toEqual(['one-off-a', 'one-off-b'])
  })

  it('orders rolled-over overdue items before today’s items', () => {
    const out = composeMyDay({
      ...base,
      tasks: [
        task({ id: 'today-late', dueDate: '2026-06-03T18:00:00.000Z' }),
        task({ id: 'today-early', dueDate: '2026-06-03T08:00:00.000Z' }),
        task({ id: 'overdue', dueDate: '2026-06-02T23:00:00.000Z' }),
      ],
    })
    expect(out.tasks.map((t) => t.id)).toEqual(['overdue', 'today-early', 'today-late'])
  })
})
