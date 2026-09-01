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

  // The prompt is hard-wrapped, so match against it unwrapped — an
  // instruction must not silently stop counting because a line broke.
  const promptText = (): string =>
    assistSystemPrompt('2026-07-20T14:03:00Z', 'America/Chicago').replace(/\s+/g, ' ')

  // The bug these guard: "Madeon at 7pm Oct 23rd" came back titled with the
  // whole capture and no date. The prompt has to ask for both halves of that
  // split — strip the when out of the title, AND resolve a year-less date
  // forwards rather than into the last occurrence.
  it('instructs the model to split date/time out of the title', () => {
    const p = promptText()
    expect(p).toMatch(/title is what remains/i)
    // The example demonstrates the split only. It must not spell out a date
    // value: the model copies what it sees, and any literal short of the
    // YYYY-MM-DD the schema demands comes back failing the format check.
    const example = p.match(/\("Madeon[^)]*\)/)?.[0]
    expect(example).toBe('("Madeon at 7pm Oct 23rd" -> title "Madeon")')
  })

  it('instructs the model to resolve a year-less date forwards', () => {
    expect(promptText()).toMatch(/no year means its next future occurrence/i)
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
  // The capture instant every case is judged against. July → CDT (UTC-5), so
  // this is 09:03 local; the dated cases below sit in March (CST, UTC-6).
  const NOW = '2026-07-20T14:03:00Z'
  const coerce = (r: RawModel, now: string = NOW) => coerceSuggestion(r, tz, now)

  it('resolves an event with date + time to a real instant', () => {
    const s = coerce(
      raw({ category: 'event', title: 'Dental cleaning', date: '2027-03-05', time: '09:00' }),
    )
    expect(s.category).toBe('event')
    expect(s.allDay).toBe(false)
    expect(s.startAt).toBe('2027-03-05T15:00:00.000Z') // CST, UTC-6
    expect(s.dueDate).toBeNull()
    expect(s.confidence).toBe('high') // fully resolved → the model's own call stands
  })

  it('adds an end time when a duration is given', () => {
    const s = coerce(
      raw({
        category: 'event',
        title: 'Standup',
        date: '2027-03-05',
        time: '09:00',
        durationMinutes: 30,
      }),
    )
    expect(s.endAt).toBe('2027-03-05T15:30:00.000Z')
  })

  it('treats a date-only event as all-day', () => {
    const s = coerce(raw({ category: 'event', title: 'Trip', date: '2027-03-05', time: null }))
    expect(s.allDay).toBe(true)
    expect(s.startAt).toBe('2027-03-05T06:00:00.000Z') // local midnight, CST
    expect(s.confidence).toBe('high') // a day is enough to place it
  })

  it('maps a timed task to an instant dueDate and a day-only task to YYYY-MM-DD', () => {
    const timed = coerce(
      raw({ category: 'task', title: 'Call dentist', date: '2027-03-05', time: '09:00' }),
    )
    expect(timed.dueDate).toBe('2027-03-05T15:00:00.000Z')
    const dayOnly = coerce(
      raw({ category: 'task', title: 'Call dentist', date: '2027-03-05', time: null }),
    )
    expect(dayOnly.dueDate).toBe('2027-03-05')
  })

  it('carries and clamps diary mood, and ignores mood for non-diary', () => {
    expect(coerce(raw({ category: 'diary', title: 'Rough day', mood: 1 })).mood).toBe(1)
    expect(coerce(raw({ category: 'diary', title: 'Great', mood: 9 })).mood).toBe(5)
    expect(coerce(raw({ category: 'diary', title: 'Meh', mood: 0 })).mood).toBe(1)
    expect(coerce(raw({ category: 'task', title: 'x', mood: 4 })).mood).toBeNull()
  })

  it('falls back to note for an unknown category', () => {
    expect(coerce(raw({ category: 'wishlist', title: 'x' })).category).toBe('note')
  })

  it('defaults an invalid confidence to medium', () => {
    expect(coerce(raw({ title: 'x', confidence: 'certain' })).confidence).toBe('medium')
  })

  it('truncates an over-long title with an ellipsis', () => {
    const long = 'a'.repeat(200)
    const s = coerce(raw({ title: long }))
    expect(s.title.length).toBeLessThanOrEqual(100)
    expect(s.title.endsWith('…')).toBe(true)
  })

  it('normalizes empty notes to null', () => {
    expect(coerce(raw({ title: 'x', notes: '   ' })).notes).toBeNull()
  })

  it('degrades a malformed model date to no due date and low confidence', () => {
    const s = coerce(raw({ category: 'task', title: 'x', date: '03/05/2027' }))
    expect(s.dueDate).toBeNull()
    expect(s.confidence).toBe('low')
  })

  // --- lost scheduling → low confidence (the client's confirm gate) -----
  // Above 'low' the client auto-saves without asking, so every path that
  // loses a date the user stated has to land on 'low'.

  it('flags an event whose date the model dropped entirely', () => {
    // The reported bug: the whole capture came back as the title, no date.
    const s = coerce(
      raw({ category: 'event', title: 'Madeon at 7pm Oct 23rd', date: null, time: null }),
    )
    expect(s.startAt).toBeNull()
    expect(s.allDay).toBe(true)
    expect(s.confidence).toBe('low')
  })

  it('flags an event whose date came back unreadable', () => {
    const s = coerce(raw({ category: 'event', title: 'Madeon', date: 'Oct 23', time: '19:00' }))
    expect(s.startAt).toBeNull()
    expect(s.confidence).toBe('low')
  })

  it('flags an unreadable time even when the date parses', () => {
    const s = coerce(raw({ category: 'event', title: 'Madeon', date: '2027-03-05', time: '7pm' }))
    expect(s.confidence).toBe('low')
  })

  it('flags a year-less date the model resolved backwards', () => {
    // "Oct 23rd" → last October rather than the next one.
    const s = coerce(raw({ category: 'event', title: 'Madeon', date: '2025-10-23', time: '19:00' }))
    expect(s.confidence).toBe('low')
  })

  it('flags a weekday the model resolved backwards by only a couple of days', () => {
    // "next Monday" → last Monday. Two local days back but late in the day,
    // so only ~34 raw hours: counting days catches it, while any hours-based
    // window padded wide enough to clear a 25-hour DST day cannot.
    const s = coerce(raw({ category: 'event', title: 'Standup', date: '2026-07-18', time: '23:00' }))
    expect(s.startAt).toBe('2026-07-19T04:00:00.000Z') // CDT, 34h before NOW
    expect(s.confidence).toBe('low')
  })

  it('leaves a just-happened event alone', () => {
    // Logging last night's gig this morning is legitimate, not a backwards
    // resolution — yesterday stays inside the tolerance.
    const s = coerce(raw({ category: 'event', title: 'Gig', date: '2026-07-19', time: '21:00' }))
    expect(s.startAt).toBe('2026-07-20T02:00:00.000Z') // CDT, UTC-5
    expect(s.confidence).toBe('high')
  })

  it('leaves a same-day all-day event alone across a DST fall-back', () => {
    // 2026-11-01 is the US fall-back Sunday, so that local day runs 25 hours:
    // local midnight (CDT) sits 24.5h behind a 23:30 local capture (CST). An
    // hours-based window would read today's own all-day event as stale.
    const s = coerce(
      raw({ category: 'event', title: 'Marathon', date: '2026-11-01', time: null }),
      '2026-11-02T05:30:00Z', // 23:30 local, same local day
    )
    expect(s.startAt).toBe('2026-11-01T05:00:00.000Z')
    expect(s.confidence).toBe('high')
  })

  it('judges staleness in the client zone, not UTC', () => {
    // At 2026-07-20T12:00Z the local day differs by zone: Auckland (+12) has
    // already ticked over to the 21st, Honolulu (-10) is still on the 20th at
    // 02:00. So an event dated the 20th is yesterday in one and today in the
    // other — inside the allowance both ways, and never stale.
    for (const zone of ['Pacific/Auckland', 'Pacific/Honolulu']) {
      const s = coerceSuggestion(
        raw({ category: 'event', title: 'Gig', date: '2026-07-20', time: '19:00' }),
        zone,
        '2026-07-20T12:00:00Z',
      )
      expect(s.confidence, zone).toBe('high')
    }
  })

  it('reports WHY an event is low so the client can name the right field', () => {
    // The client can't derive this: a backwards-resolved date arrives with a
    // startAt, and a model unsure about the category arrives with a good one.
    expect(coerce(raw({ category: 'event', title: 'Madeon' })).dateUncertain).toBe(true)
    expect(
      coerce(raw({ category: 'event', title: 'Madeon', date: '2025-10-23', time: '19:00' }))
        .dateUncertain,
    ).toBe(true)
    // Model-declared low confidence with a perfectly good date is NOT a date
    // problem — the flag must stay off so the hint asks about the category.
    const modelUnsure = coerce(
      raw({
        category: 'event',
        title: 'Madeon',
        date: '2027-03-05',
        time: '09:00',
        confidence: 'low',
      }),
    )
    expect(modelUnsure.confidence).toBe('low')
    expect(modelUnsure.dateUncertain).toBe(false)
  })

  it('does not flag a stray unreadable date on a category that keeps no date', () => {
    // Shopping and note drop date/time either way, so confirming a field the
    // edit card never shows would be friction with nothing behind it.
    expect(coerce(raw({ category: 'shopping', title: 'Milk', date: 'next week' })).confidence).toBe(
      'high',
    )
    expect(coerce(raw({ category: 'note', title: 'Call the vet', time: '5ish' })).confidence).toBe(
      'high',
    )
  })

  it('keeps a valid food capture high despite a stray unreadable date', () => {
    const s = coerce(
      raw({
        category: 'food',
        title: '5 cherries',
        date: 'sometime',
        items: [{ name: 'Cherries', grams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 }],
      }),
    )
    expect(s.category).toBe('food')
    expect(s.confidence).toBe('high')
  })

  it('flags a task whose stated due date came back unreadable', () => {
    // Unlike an event, a task with NO date is normal — only a lost one flags.
    expect(coerce(raw({ category: 'task', title: 'Call dentist' })).confidence).toBe('high')
    expect(
      coerce(raw({ category: 'task', title: 'Call dentist', date: 'next Tuesday' })).confidence,
    ).toBe('low')
  })

  it('does not read a blank or literal-null date as a dropped one', () => {
    // Some runtimes stringify the explicit nulls the prompt asks for; those
    // are "no date", not "date lost", and must not flag an undated note.
    expect(coerce(raw({ category: 'note', title: 'x', date: '' })).confidence).toBe('high')
    expect(coerce(raw({ category: 'note', title: 'x', date: 'null' })).confidence).toBe('high')
    expect(coerce(raw({ category: 'note', title: 'x', time: '  ' })).confidence).toBe('high')
  })

  it('coerces a food capture into bounded items, no dates', () => {
    const s = coerce(
      raw({
        category: 'food',
        title: '5 cherries',
        items: [
          { name: 'Cherries', grams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 },
        ],
      }),
    )
    expect(s.category).toBe('food')
    expect(s.items).toEqual([
      { name: 'Cherries', grams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 },
    ])
    expect(s.startAt).toBeNull()
    expect(s.dueDate).toBeNull()
  })

  it('clamps out-of-range food macros to the schema ceilings', () => {
    const s = coerce(
      raw({
        category: 'food',
        title: 'huge',
        items: [{ name: 'Cake', grams: 99999, kcal: 99999, proteinG: 9999, carbsG: 9999, fatG: 9999 }],
      }),
    )
    expect(s.items![0]!.grams).toBeLessThanOrEqual(5000)
    expect(s.items![0]!.kcal).toBeLessThanOrEqual(20000)
    expect(s.items![0]!.proteinG).toBeLessThanOrEqual(2000)
  })

  it('fills grams from kcal density when the model omits them', () => {
    const s = coerce(
      raw({
        category: 'food',
        title: 'x',
        items: [{ name: 'Soda', grams: null, kcal: 150, proteinG: 0, carbsG: 39, fatG: 0 }],
      }),
    )
    expect(s.items![0]!.grams).toBeGreaterThanOrEqual(1)
  })

  it('drops items with no usable kcal and degrades an empty food capture to a low-confidence note', () => {
    const s = coerce(
      raw({
        category: 'food',
        title: 'mystery',
        items: [{ name: 'Something', grams: null, kcal: null, proteinG: null, carbsG: null, fatG: null }],
      }),
    )
    expect(s.category).toBe('note')
    expect(s.confidence).toBe('low')
    expect(s.items).toBeNull()
  })

  it('carries no items on non-food categories', () => {
    const s = coerce(raw({ category: 'shopping', title: 'Milk' }))
    expect(s.items).toBeNull()
  })
})
