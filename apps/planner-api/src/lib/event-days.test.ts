import { describe, it, expect } from 'vitest'
import type { UserEventDto } from '@rallypoint/events-client'
import { expandEventDays, isAllDay } from './event-days.js'

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

describe('expandEventDays', () => {
  it('flattens one event into one item per day, carrying event fields + owned', () => {
    const items = expandEventDays([
      userEvent({
        eventId: 'event_a',
        slug: 'a-fest',
        name: 'A Fest',
        owned: true,
        days: [
          { date: '2026-06-04', dayLabel: 'Day 1', startTime: '10:00', endTime: '18:00' },
          { date: '2026-06-05', dayLabel: 'Day 2', startTime: null, endTime: null },
        ],
      }),
    ])
    expect(items).toEqual([
      {
        eventId: 'event_a',
        slug: 'a-fest',
        name: 'A Fest',
        scopeType: 'group',
        date: '2026-06-04',
        dayLabel: 'Day 1',
        startTime: '10:00',
        endTime: '18:00',
        owned: true,
      },
      {
        eventId: 'event_a',
        slug: 'a-fest',
        name: 'A Fest',
        scopeType: 'group',
        date: '2026-06-05',
        dayLabel: 'Day 2',
        startTime: null,
        endTime: null,
        owned: true,
      },
    ])
  })

  it('yields nothing for an event with no days', () => {
    expect(expandEventDays([userEvent({ eventId: 'event_empty' })])).toEqual([])
  })
})

describe('isAllDay', () => {
  it('is true only when the start time is null', () => {
    const base = {
      eventId: 'e',
      slug: 's',
      name: 'n',
      scopeType: 'group',
      date: '2026-06-04',
      dayLabel: 'D',
      endTime: null,
      owned: false,
    }
    expect(isAllDay({ ...base, startTime: null })).toBe(true)
    expect(isAllDay({ ...base, startTime: '09:00' })).toBe(false)
  })
})
