import { describe, it, expect } from 'vitest'
import {
  AssistRequestSchema,
  assistSystemPrompt,
  buildAssistInput,
  coerceSuggestion,
  parseAssistOutput,
  type RawModel,
} from './assist.js'

// Note: localAnchor + wallClockToInstant moved to @rallypoint/shared
// (packages/shared/src/timezone.test.ts); coerceSuggestion below still
// exercises the tz resolution transitively (startAt / dueDate instants).

// A raw model row with all fields defaulted; override per case.
function raw(overrides: Partial<RawModel>): RawModel {
  return { category: 'note', title: 'x', confidence: 'high', ...overrides }
}

describe('AssistRequestSchema', () => {
  it('accepts a well-formed request', () => {
    const r = AssistRequestSchema.safeParse({
      text: 'Buy strawberries',
      clientNow: '2026-07-20T14:03:00Z',
      tz: 'America/Chicago',
    })
    expect(r.success).toBe(true)
  })

  it('rejects empty text and over-long text', () => {
    expect(
      AssistRequestSchema.safeParse({ text: '   ', clientNow: '2026-07-20T14:03:00Z', tz: 'UTC' })
        .success,
    ).toBe(false)
    expect(
      AssistRequestSchema.safeParse({
        text: 'x'.repeat(501),
        clientNow: '2026-07-20T14:03:00Z',
        tz: 'UTC',
      }).success,
    ).toBe(false)
  })

  it('rejects a non-instant clientNow', () => {
    expect(
      AssistRequestSchema.safeParse({ text: 'hi', clientNow: 'not-a-date', tz: 'UTC' }).success,
    ).toBe(false)
  })
})

describe('assistSystemPrompt / buildAssistInput', () => {
  it('embeds the resolved local anchor and every category', () => {
    const p = assistSystemPrompt('2026-07-20T14:03:00Z', 'America/Chicago')
    expect(p).toContain('2026-07-20')
    expect(p).toContain('America/Chicago')
    for (const cat of ['task', 'shopping', 'event', 'note', 'diary']) {
      expect(p).toContain(cat)
    }
  })

  it('builds a chat input carrying the user text and a token cap', () => {
    const input = buildAssistInput('Buy milk', '2026-07-20T14:03:00Z', 'UTC') as {
      messages: { role: string; content: string }[]
      max_tokens: number
    }
    expect(input.messages[1]).toEqual({ role: 'user', content: 'Buy milk' })
    expect(input.max_tokens).toBeGreaterThan(0)
  })
})

describe('parseAssistOutput', () => {
  it('accepts an already-parsed object', () => {
    const out = parseAssistOutput({ category: 'shopping', title: 'Strawberries', confidence: 'high' })
    expect(out?.category).toBe('shopping')
  })

  it('recovers JSON wrapped in prose / code fences', () => {
    const reply = 'Sure!\n```json\n{"category":"task","title":"Call dentist","confidence":"medium"}\n```'
    const out = parseAssistOutput(reply)
    expect(out?.title).toBe('Call dentist')
  })

  it('returns null on non-JSON garbage', () => {
    expect(parseAssistOutput('I could not understand that.')).toBeNull()
    expect(parseAssistOutput('{ not valid json')).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    expect(parseAssistOutput({ title: 'x' })).toBeNull()
  })
})

describe('coerceSuggestion', () => {
  const tz = 'America/Chicago'

  it('resolves an event with date + time to a real instant', () => {
    const s = coerceSuggestion(
      raw({ category: 'event', title: 'Dental cleaning', date: '2027-03-05', time: '09:00' }),
      tz,
    )
    expect(s.category).toBe('event')
    expect(s.allDay).toBe(false)
    expect(s.startAt).toBe('2027-03-05T15:00:00.000Z') // CST, UTC-6
    expect(s.dueDate).toBeNull()
  })

  it('adds an end time when a duration is given', () => {
    const s = coerceSuggestion(
      raw({
        category: 'event',
        title: 'Standup',
        date: '2027-03-05',
        time: '09:00',
        durationMinutes: 30,
      }),
      tz,
    )
    expect(s.endAt).toBe('2027-03-05T15:30:00.000Z')
  })

  it('treats a date-only event as all-day', () => {
    const s = coerceSuggestion(
      raw({ category: 'event', title: 'Trip', date: '2027-03-05', time: null }),
      tz,
    )
    expect(s.allDay).toBe(true)
    expect(s.startAt).toBe('2027-03-05T06:00:00.000Z') // local midnight, CST
  })

  it('maps a timed task to an instant dueDate and a day-only task to YYYY-MM-DD', () => {
    const timed = coerceSuggestion(
      raw({ category: 'task', title: 'Call dentist', date: '2027-03-05', time: '09:00' }),
      tz,
    )
    expect(timed.dueDate).toBe('2027-03-05T15:00:00.000Z')
    const dayOnly = coerceSuggestion(
      raw({ category: 'task', title: 'Call dentist', date: '2027-03-05', time: null }),
      tz,
    )
    expect(dayOnly.dueDate).toBe('2027-03-05')
  })

  it('carries and clamps diary mood, and ignores mood for non-diary', () => {
    expect(coerceSuggestion(raw({ category: 'diary', title: 'Rough day', mood: 1 }), tz).mood).toBe(1)
    expect(coerceSuggestion(raw({ category: 'diary', title: 'Great', mood: 9 }), tz).mood).toBe(5)
    expect(coerceSuggestion(raw({ category: 'diary', title: 'Meh', mood: 0 }), tz).mood).toBe(1)
    expect(coerceSuggestion(raw({ category: 'task', title: 'x', mood: 4 }), tz).mood).toBeNull()
  })

  it('falls back to note for an unknown category', () => {
    expect(coerceSuggestion(raw({ category: 'wishlist', title: 'x' }), tz).category).toBe('note')
  })

  it('defaults an invalid confidence to medium', () => {
    expect(coerceSuggestion(raw({ title: 'x', confidence: 'certain' }), tz).confidence).toBe('medium')
  })

  it('truncates an over-long title with an ellipsis', () => {
    const long = 'a'.repeat(200)
    const s = coerceSuggestion(raw({ title: long }), tz)
    expect(s.title.length).toBeLessThanOrEqual(100)
    expect(s.title.endsWith('…')).toBe(true)
  })

  it('normalizes empty notes to null', () => {
    expect(coerceSuggestion(raw({ title: 'x', notes: '   ' }), tz).notes).toBeNull()
  })

  it('degrades a malformed model date to no due date rather than throwing', () => {
    const s = coerceSuggestion(raw({ category: 'task', title: 'x', date: '03/05/2027' }), tz)
    expect(s.dueDate).toBeNull()
  })

  it('coerces a food capture into bounded items, no dates', () => {
    const s = coerceSuggestion(
      raw({
        category: 'food',
        title: '5 cherries',
        items: [
          { name: 'Cherries', grams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 },
        ],
      }),
      tz,
    )
    expect(s.category).toBe('food')
    expect(s.items).toEqual([
      { name: 'Cherries', grams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 },
    ])
    expect(s.startAt).toBeNull()
    expect(s.dueDate).toBeNull()
  })

  it('clamps out-of-range food macros to the schema ceilings', () => {
    const s = coerceSuggestion(
      raw({
        category: 'food',
        title: 'huge',
        items: [{ name: 'Cake', grams: 99999, kcal: 99999, proteinG: 9999, carbsG: 9999, fatG: 9999 }],
      }),
      tz,
    )
    expect(s.items![0]!.grams).toBeLessThanOrEqual(5000)
    expect(s.items![0]!.kcal).toBeLessThanOrEqual(20000)
    expect(s.items![0]!.proteinG).toBeLessThanOrEqual(2000)
  })

  it('fills grams from kcal density when the model omits them', () => {
    const s = coerceSuggestion(
      raw({
        category: 'food',
        title: 'x',
        items: [{ name: 'Soda', grams: null, kcal: 150, proteinG: 0, carbsG: 39, fatG: 0 }],
      }),
      tz,
    )
    expect(s.items![0]!.grams).toBeGreaterThanOrEqual(1)
  })

  it('drops items with no usable kcal and degrades an empty food capture to a low-confidence note', () => {
    const s = coerceSuggestion(
      raw({
        category: 'food',
        title: 'mystery',
        items: [{ name: 'Something', grams: null, kcal: null, proteinG: null, carbsG: null, fatG: null }],
      }),
      tz,
    )
    expect(s.category).toBe('note')
    expect(s.confidence).toBe('low')
    expect(s.items).toBeNull()
  })

  it('carries no items on non-food categories', () => {
    const s = coerceSuggestion(raw({ category: 'shopping', title: 'Milk' }), tz)
    expect(s.items).toBeNull()
  })
})
