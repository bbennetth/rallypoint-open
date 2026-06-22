import { describe, expect, it } from 'vitest'
import { parseMyDayView } from './my-day-view.js'

describe('parseMyDayView', () => {
  it('passes through the calendar lenses', () => {
    expect(parseMyDayView('month')).toBe('month')
    expect(parseMyDayView('week')).toBe('week')
  })

  it('keeps an explicit agenda value', () => {
    expect(parseMyDayView('agenda')).toBe('agenda')
  })

  it('falls back to agenda for missing / stale / malformed values', () => {
    expect(parseMyDayView(undefined)).toBe('agenda')
    expect(parseMyDayView(null)).toBe('agenda')
    expect(parseMyDayView('')).toBe('agenda')
    expect(parseMyDayView('Month')).toBe('agenda') // case-sensitive
    expect(parseMyDayView('today')).toBe('agenda') // legacy mode value
    expect(parseMyDayView(123)).toBe('agenda')
    expect(parseMyDayView({})).toBe('agenda')
  })
})
