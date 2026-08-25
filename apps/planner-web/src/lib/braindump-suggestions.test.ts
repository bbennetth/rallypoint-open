import { describe, expect, it } from 'vitest'
import {
  eventSuggestionKey,
  hasSchedulableStart,
  hasSuggestions,
  suggestedEventFields,
  suggestedTaskOpts,
  taskSuggestionKey,
} from './braindump-suggestions.js'
import type { BraindumpEventSuggestion, BraindumpTaskSuggestion } from './api.js'

function taskSuggestion(over: Partial<BraindumpTaskSuggestion> = {}): BraindumpTaskSuggestion {
  return { title: 'Buy milk', dueDate: null, ...over }
}

function eventSuggestion(over: Partial<BraindumpEventSuggestion> = {}): BraindumpEventSuggestion {
  return { title: 'Dentist', startAt: null, endAt: null, allDay: false, ...over }
}

describe('suggestedTaskOpts', () => {
  it('includes dueDate when present', () => {
    expect(suggestedTaskOpts(taskSuggestion({ dueDate: '2026-06-10' }))).toEqual({
      dueDate: '2026-06-10',
    })
  })

  it('omits dueDate when null', () => {
    expect(suggestedTaskOpts(taskSuggestion({ dueDate: null }))).toEqual({})
  })
})

describe('suggestedEventFields', () => {
  it('maps title/allDay and includes startAt/endAt when present', () => {
    const s = eventSuggestion({
      title: 'Dentist',
      startAt: '2026-06-10T09:00:00.000Z',
      endAt: '2026-06-10T10:00:00.000Z',
      allDay: false,
    })
    expect(suggestedEventFields(s)).toEqual({
      name: 'Dentist',
      allDay: false,
      startAt: '2026-06-10T09:00:00.000Z',
      endAt: '2026-06-10T10:00:00.000Z',
    })
  })

  it('omits startAt/endAt when null', () => {
    const s = eventSuggestion({ startAt: null, endAt: null, allDay: true })
    expect(suggestedEventFields(s)).toEqual({ name: 'Dentist', allDay: true })
  })
})

describe('hasSchedulableStart', () => {
  it('is true when startAt is set', () => {
    expect(hasSchedulableStart(eventSuggestion({ startAt: '2026-06-10T09:00:00.000Z' }))).toBe(true)
  })

  it('is false when startAt is null', () => {
    expect(hasSchedulableStart(eventSuggestion({ startAt: null }))).toBe(false)
  })
})

describe('taskSuggestionKey / eventSuggestionKey', () => {
  it('builds a stable key including index and title', () => {
    expect(taskSuggestionKey(taskSuggestion({ title: 'Buy milk' }), 2)).toBe('task:2:Buy milk')
    expect(eventSuggestionKey(eventSuggestion({ title: 'Dentist' }), 0)).toBe('event:0:Dentist')
  })
})

describe('hasSuggestions', () => {
  it('is false when both lists are empty', () => {
    expect(hasSuggestions({ taskSuggestions: [], eventSuggestions: [] })).toBe(false)
  })

  it('is true when there is at least one task suggestion', () => {
    expect(hasSuggestions({ taskSuggestions: [taskSuggestion()], eventSuggestions: [] })).toBe(true)
  })

  it('is true when there is a schedulable event suggestion', () => {
    expect(
      hasSuggestions({
        taskSuggestions: [],
        eventSuggestions: [eventSuggestion({ startAt: '2026-06-10T09:00:00.000Z' })],
      }),
    ).toBe(true)
  })

  it('is false when the only event suggestion has no schedulable start', () => {
    expect(
      hasSuggestions({
        taskSuggestions: [],
        eventSuggestions: [eventSuggestion({ startAt: null })],
      }),
    ).toBe(false)
  })
})
