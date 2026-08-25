import { describe, expect, it } from 'vitest'
import type { MyDay, MyDayEvent, MyDayTask } from './api.js'
import { buildMyDayView, buildTaskSummary, fmtModality, fmtWorkout, headingLabel } from './my-day-sections.js'

function task(over: Partial<MyDayTask> = {}): MyDayTask {
  return {
    id: 't1',
    listId: 'list-1',
    title: 'Task',
    completed: false,
    priority: null,
    dueDate: null,
    seriesId: null,
    customFields: {},
    ...over,
  }
}

function myDay(over: Partial<MyDay> = {}): MyDay {
  return {
    date: '2026-08-08',
    timezone: 'UTC',
    tasks: [],
    undatedTasks: [],
    events: [],
    eventDays: [],
    training: [],
    choresListId: null,
    ...over,
  }
}

describe('fmtModality', () => {
  it('capitalises the first letter only', () => {
    expect(fmtModality('strength')).toBe('Strength')
    expect(fmtModality('conditioning')).toBe('Conditioning')
  })
})

function workout(over: Partial<Parameters<typeof fmtWorkout>[0]> = {}): Parameters<typeof fmtWorkout>[0] {
  return {
    id: 'w1',
    performedAt: '2026-08-08T00:00:00Z',
    modality: 'strength',
    title: null,
    durationS: null,
    setCount: 1,
    ...over,
  }
}

describe('fmtWorkout', () => {
  it('joins title + set count when a title is present', () => {
    expect(fmtWorkout(workout({ title: 'Push Day', setCount: 12 }))).toBe('Push Day · 12 sets')
  })

  it('singularizes a single set and omits the title when absent', () => {
    expect(fmtWorkout(workout({ title: null, setCount: 1 }))).toBe('1 set')
  })
})

describe('headingLabel', () => {
  it('formats a YYYY-MM-DD date as a long weekday label', () => {
    expect(headingLabel('2026-08-08')).toMatch(/2026|August|Saturday/)
  })

  it('falls back to the raw string for an unparseable date', () => {
    expect(headingLabel('not-a-date')).toBe('not-a-date')
  })
})

describe('buildTaskSummary', () => {
  it('counts total/done/left from a mixed list', () => {
    const tasks = [task({ id: 'a', completed: true }), task({ id: 'b', completed: false })]
    expect(buildTaskSummary(tasks)).toEqual({ total: 2, done: 1, left: 1 })
  })

  it('handles an empty list', () => {
    expect(buildTaskSummary([])).toEqual({ total: 0, done: 0, left: 0 })
  })
})

describe('buildMyDayView', () => {
  it('lifts chore-list tasks into their own bucket, excluded from the summary', () => {
    const data = myDay({
      tasks: [
        task({ id: 'chore-1', listId: 'chores-list' }),
        task({ id: 'task-1', listId: 'list-1' }),
      ],
      choresListId: 'chores-list',
    })
    const view = buildMyDayView(data, '2026-08-08', 'chores-list')
    expect(view.chores.map((c) => c.id)).toEqual(['chore-1'])
    expect(view.total).toBe(1)
    expect(view.left).toBe(1)
  })

  it('counts events + eventDays for eventsCount', () => {
    const event: MyDayEvent = {
      id: 'e1',
      name: 'Concert',
      startAt: null,
      endAt: null,
      allDay: true,
      locationLabel: null,
      ticketCount: 0,
      ticketPlatform: null,
      ticketAccountEmail: null,
    }
    const data = myDay({ events: [event] })
    const view = buildMyDayView(data, '2026-08-08', null)
    expect(view.eventsCount).toBe(1)
  })
})
