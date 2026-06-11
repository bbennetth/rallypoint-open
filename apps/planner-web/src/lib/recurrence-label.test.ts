import { describe, expect, it } from 'vitest'
import {
  describeRecurrence,
  formatRuleDate,
  formatRuleDateShort,
  nextOccurrence,
  summarizeNext,
  type RecurrenceRuleLike,
} from './recurrence-label.js'

function rule(overrides: Partial<RecurrenceRuleLike> = {}): RecurrenceRuleLike {
  return { freq: 'weekly', interval: 1, byDay: null, until: null, count: null, ...overrides }
}

describe('describeRecurrence — daily', () => {
  it('every day at interval 1', () => {
    expect(describeRecurrence(rule({ freq: 'daily', interval: 1 }))).toBe('Every day')
  })
  it('every N days at interval > 1', () => {
    expect(describeRecurrence(rule({ freq: 'daily', interval: 3 }))).toBe('Every 3 days')
  })
  it('treats interval 0 as 1 (defensive)', () => {
    expect(describeRecurrence(rule({ freq: 'daily', interval: 0 }))).toBe('Every day')
  })
})

describe('describeRecurrence — weekly', () => {
  it('plain weekly when no byDay', () => {
    expect(describeRecurrence(rule({ byDay: null }))).toBe('Weekly')
    expect(describeRecurrence(rule({ byDay: [] }))).toBe('Weekly')
  })
  it('collapses Mon–Fri to "Every weekday"', () => {
    expect(describeRecurrence(rule({ byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }))).toBe('Every weekday')
  })
  it('collapses Sat+Sun to "Every weekend"', () => {
    expect(describeRecurrence(rule({ byDay: ['SU', 'SA'] }))).toBe('Every weekend')
  })
  it('lists specific days in week order regardless of input order', () => {
    expect(describeRecurrence(rule({ byDay: ['WE', 'MO'] }))).toBe('Weekly on Mon, Wed')
  })
  it('every N weeks without byDay', () => {
    expect(describeRecurrence(rule({ interval: 2, byDay: null }))).toBe('Every 2 weeks')
  })
  it('every N weeks with specific days', () => {
    expect(describeRecurrence(rule({ interval: 2, byDay: ['MO', 'WE'] }))).toBe(
      'Every 2 weeks on Mon, Wed',
    )
  })
  it('ignores unknown day codes', () => {
    expect(describeRecurrence(rule({ byDay: ['MO', 'XX'] }))).toBe('Weekly on Mon')
  })
})

describe('describeRecurrence — termination suffix', () => {
  it('appends "until <date>" when until is set', () => {
    expect(describeRecurrence(rule({ freq: 'daily', interval: 1, until: '2026-06-11' }))).toBe(
      'Every day until Jun 11, 2026',
    )
  })
  it('appends "· N times" when count is set', () => {
    expect(describeRecurrence(rule({ freq: 'daily', interval: 1, count: 5 }))).toBe(
      'Every day · 5 times',
    )
  })
  it('prefers until over count when both present', () => {
    expect(
      describeRecurrence(rule({ freq: 'daily', interval: 1, until: '2026-06-11', count: 5 })),
    ).toBe('Every day until Jun 11, 2026')
  })
  it('no suffix when neither is set', () => {
    expect(describeRecurrence(rule({ freq: 'daily', interval: 1 }))).toBe('Every day')
  })
})

describe('date formatters (UTC-stable)', () => {
  it('formatRuleDate includes the year', () => {
    expect(formatRuleDate('2026-06-11')).toBe('Jun 11, 2026')
  })
  it('formatRuleDateShort omits the year', () => {
    expect(formatRuleDateShort('2026-06-11')).toBe('Jun 11')
  })
})

describe('nextOccurrence', () => {
  it('returns the first date', () => {
    expect(nextOccurrence(['2026-06-11', '2026-06-15'])).toBe('2026-06-11')
  })
  it('returns null for empty / nullish', () => {
    expect(nextOccurrence([])).toBeNull()
    expect(nextOccurrence(null)).toBeNull()
    expect(nextOccurrence(undefined)).toBeNull()
  })
})

describe('summarizeNext', () => {
  it('summarizes first + following dates', () => {
    expect(summarizeNext(['2026-06-11', '2026-06-15', '2026-06-18'])).toBe(
      'Next Jun 11 · then Jun 15, Jun 18',
    )
  })
  it('just the next date when only one', () => {
    expect(summarizeNext(['2026-06-11'])).toBe('Next Jun 11')
  })
  it('honours the limit', () => {
    expect(summarizeNext(['2026-06-11', '2026-06-15', '2026-06-18', '2026-06-22'], 2)).toBe(
      'Next Jun 11 · then Jun 15',
    )
  })
  it('empty message when no dates', () => {
    expect(summarizeNext([])).toBe('No upcoming dates')
    expect(summarizeNext(null)).toBe('No upcoming dates')
  })
})
