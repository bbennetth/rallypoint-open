import { describe, it, expect } from 'vitest'
import {
  EnrichRequestSchema,
  SummaryRequestSchema,
  MAX_SUMMARY_ENTRIES,
  MAX_SUMMARY_TOTAL_CHARS,
  parseEnrichOutput,
  parseSummaryOutput,
  coerceEnrichment,
  coerceSummary,
  encodeAiAnalysis,
  decodeAiAnalysis,
  enrichSystemPrompt,
  summarySystemPrompt,
  buildEnrichInput,
  buildSummaryInput,
  AI_ANALYSIS_VERSION,
  BRAINDUMP_ENRICH_MAX_TOKENS,
  BRAINDUMP_SUMMARY_MAX_TOKENS,
  MAX_THEMES,
  MAX_ENTITIES,
  MAX_ANALYSIS_SUMMARY,
  MAX_SUGGESTED_TASKS,
  MAX_SUGGESTED_EVENTS,
  MAX_SUMMARY_HIGHLIGHTS,
  MAX_SUMMARY_HIGHLIGHT_LEN,
  MAX_SUMMARY_TEXT,
  MAX_SUMMARY_MOOD_LEN,
  BRAINDUMP_CATEGORIES,
  type RawEnrich,
  type RawSummary,
} from './braindump.js'

// A raw enrich row with all required fields defaulted; override per case.
function rawEnrich(overrides: Partial<RawEnrich>): RawEnrich {
  return { category: 'Ideas', title: 'A dump', ...overrides }
}

function rawSummary(overrides: Partial<RawSummary>): RawSummary {
  return { summary: 'A fine week.', ...overrides }
}

describe('EnrichRequestSchema', () => {
  it('accepts a well-formed request', () => {
    const r = EnrichRequestSchema.safeParse({
      text: 'Had a great idea today',
      clientNow: '2026-07-20T14:03:00Z',
      tz: 'America/Chicago',
    })
    expect(r.success).toBe(true)
  })

  it('rejects empty text and over-long text', () => {
    expect(
      EnrichRequestSchema.safeParse({ text: '   ', clientNow: '2026-07-20T14:03:00Z', tz: 'UTC' })
        .success,
    ).toBe(false)
    expect(
      EnrichRequestSchema.safeParse({
        text: 'x'.repeat(4001),
        clientNow: '2026-07-20T14:03:00Z',
        tz: 'UTC',
      }).success,
    ).toBe(false)
  })

  it('rejects a non-instant clientNow', () => {
    expect(
      EnrichRequestSchema.safeParse({ text: 'hi', clientNow: 'not-a-date', tz: 'UTC' }).success,
    ).toBe(false)
  })

  it('accepts a valid knownConcepts array and accepts its omission', () => {
    expect(
      EnrichRequestSchema.safeParse({
        text: 'hi',
        clientNow: '2026-07-20T14:03:00Z',
        tz: 'UTC',
        knownConcepts: ['skin', 'Sam'],
      }).success,
    ).toBe(true)
    expect(
      EnrichRequestSchema.safeParse({ text: 'hi', clientNow: '2026-07-20T14:03:00Z', tz: 'UTC' })
        .success,
    ).toBe(true)
  })

  it('rejects more than 40 knownConcepts', () => {
    const knownConcepts = Array.from({ length: 41 }, (_, i) => `concept${i}`)
    expect(
      EnrichRequestSchema.safeParse({
        text: 'hi',
        clientNow: '2026-07-20T14:03:00Z',
        tz: 'UTC',
        knownConcepts,
      }).success,
    ).toBe(false)
  })

  it('rejects a blank knownConcepts entry', () => {
    expect(
      EnrichRequestSchema.safeParse({
        text: 'hi',
        clientNow: '2026-07-20T14:03:00Z',
        tz: 'UTC',
        knownConcepts: ['skin', '   '],
      }).success,
    ).toBe(false)
  })
})

describe('SummaryRequestSchema', () => {
  const entry = (over: Partial<{ date: string; category: string | null; text: string }> = {}) => ({
    date: '2026-06-01',
    category: 'Ideas',
    text: 'Something happened.',
    ...over,
  })

  it('accepts a well-formed request', () => {
    expect(SummaryRequestSchema.safeParse({ entries: [entry()] }).success).toBe(true)
  })

  it('rejects an empty entries array', () => {
    expect(SummaryRequestSchema.safeParse({ entries: [] }).success).toBe(false)
  })

  it(`rejects more than ${MAX_SUMMARY_ENTRIES} entries`, () => {
    const entries = Array.from({ length: MAX_SUMMARY_ENTRIES + 1 }, () => entry())
    expect(SummaryRequestSchema.safeParse({ entries }).success).toBe(false)
  })

  it(`accepts exactly ${MAX_SUMMARY_ENTRIES} entries`, () => {
    const entries = Array.from({ length: MAX_SUMMARY_ENTRIES }, () => entry())
    expect(SummaryRequestSchema.safeParse({ entries }).success).toBe(true)
  })

  it(`rejects a corpus whose total text exceeds ${MAX_SUMMARY_TOTAL_CHARS} chars`, () => {
    // Two entries just under the per-entry 1000 cap, but many of them push the
    // combined total over the 15000-char refinement.
    const entries = Array.from({ length: 16 }, (_, i) =>
      entry({ date: '2026-06-01', text: 'x'.repeat(1000), category: `c${i}` }),
    )
    const r = SummaryRequestSchema.safeParse({ entries })
    expect(r.success).toBe(false)
  })

  it('accepts a corpus at or under the total-chars cap', () => {
    const entries = Array.from({ length: 15 }, () => entry({ text: 'x'.repeat(1000) }))
    expect(SummaryRequestSchema.safeParse({ entries }).success).toBe(true)
  })
})

describe('prompts', () => {
  it('enrichSystemPrompt embeds the resolved local anchor and every category', () => {
    const p = enrichSystemPrompt('2026-07-20T14:03:00Z', 'America/Chicago')
    expect(p).toContain('2026-07-20')
    expect(p).toContain('America/Chicago')
    for (const cat of ['Ideas', 'Feelings', 'Work', 'Health', 'People', 'Plans', 'Journal', 'Reference', 'Other']) {
      expect(p).toContain(cat)
    }
  })

  it('enrichSystemPrompt omits the vocabulary line when no known concepts are given', () => {
    const p = enrichSystemPrompt('2026-07-20T14:03:00Z', 'America/Chicago')
    expect(p).not.toContain('Reuse these existing labels')
    const p2 = enrichSystemPrompt('2026-07-20T14:03:00Z', 'America/Chicago', [])
    expect(p2).not.toContain('Reuse these existing labels')
  })

  it('enrichSystemPrompt appends the vocabulary line with the joined labels when known concepts are given', () => {
    const p = enrichSystemPrompt('2026-07-20T14:03:00Z', 'America/Chicago', ['skin', 'Sam'])
    expect(p).toContain('Reuse these existing labels verbatim when a theme or entity means the same thing: skin, Sam')
  })

  it('summarySystemPrompt asks for the versioned JSON shape', () => {
    const p = summarySystemPrompt()
    expect(p).toContain('summary')
    expect(p).toContain('highlights')
    expect(p).toContain('moodTrend')
  })

  // The QA truncation failures came from the model padding highlights into
  // full sentences and running past the token cap; the prompt now states the
  // brevity bounds explicitly so it aims for what coercion keeps.
  it('summarySystemPrompt states the brevity bounds', () => {
    const p = summarySystemPrompt()
    expect(p).toContain('3-5 sentences')
    expect(p).toContain('under 20 words')
    expect(p).toContain('at most 5 highlights')
  })

  it('enrichSystemPrompt quotes the coercion bounds for themes, entities, tasks and events', () => {
    const p = enrichSystemPrompt('2026-07-20T14:03:00Z', 'America/Chicago')
    expect(p).toContain(`up to ${MAX_THEMES} recurring themes`)
    expect(p).toContain(`up to\n${MAX_ENTITIES} named entities`)
    expect(p).toContain(`at most ${MAX_SUGGESTED_TASKS} of each`)
  })
})

// max_tokens is a ceiling, not a prefill: it must comfortably hold the
// LARGEST response coercion can keep, or a verbose-but-valid reply gets cut
// mid-array and the whole call 422s (`failure: truncated` in QA logs at the
// old 1024 / 768 caps). 3 chars/token is a conservative English+JSON
// estimate (the usual figure is ~4), so these floors err on the safe side.
describe('output token caps', () => {
  const CHARS_PER_TOKEN = 3
  const tokensFor = (o: unknown): number => Math.ceil(JSON.stringify(o).length / CHARS_PER_TOKEN)

  it('buildEnrichInput / buildSummaryInput pass the exported caps as max_tokens', () => {
    const e = buildEnrichInput('hello', '2026-07-20T14:03:00Z', 'America/Chicago')
    expect(e['max_tokens']).toBe(BRAINDUMP_ENRICH_MAX_TOKENS)
    const s = buildSummaryInput([{ date: '2026-07-20', category: null, text: 'hello' }])
    expect(s['max_tokens']).toBe(BRAINDUMP_SUMMARY_MAX_TOKENS)
  })

  it('the enrich cap holds a response maxed out at every coercion bound', () => {
    const longest = [...BRAINDUMP_CATEGORIES].sort((a, b) => b.length - a.length)[0]
    const worst = {
      category: longest,
      title: 'T'.repeat(100),
      themes: Array.from({ length: MAX_THEMES }, () => 't'.repeat(40)),
      entities: Array.from({ length: MAX_ENTITIES }, () => ({ name: 'n'.repeat(80), kind: 'person' })),
      summary: 's'.repeat(MAX_ANALYSIS_SUMMARY),
      tasks: Array.from({ length: MAX_SUGGESTED_TASKS }, () => ({
        title: 't'.repeat(100),
        date: '2026-07-21',
        time: '09:30',
      })),
      events: Array.from({ length: MAX_SUGGESTED_EVENTS }, () => ({
        title: 'e'.repeat(100),
        date: '2026-07-21',
        time: '09:30',
        durationMinutes: 1440,
      })),
    }
    expect(tokensFor(worst)).toBeLessThan(BRAINDUMP_ENRICH_MAX_TOKENS)
  })

  it('the summary cap holds a response maxed out at every coercion bound', () => {
    const worst = {
      summary: 's'.repeat(MAX_SUMMARY_TEXT),
      highlights: Array.from({ length: MAX_SUMMARY_HIGHLIGHTS }, () => 'h'.repeat(MAX_SUMMARY_HIGHLIGHT_LEN)),
      moodTrend: 'm'.repeat(MAX_SUMMARY_MOOD_LEN),
    }
    expect(tokensFor(worst)).toBeLessThan(BRAINDUMP_SUMMARY_MAX_TOKENS)
  })
})

describe('parseEnrichOutput', () => {
  it('accepts an already-parsed object', () => {
    const out = parseEnrichOutput({ category: 'Work', title: 'Standup notes' })
    expect(out?.category).toBe('Work')
  })

  it('recovers JSON wrapped in prose / code fences', () => {
    const reply = 'Sure!\n```json\n{"category":"Ideas","title":"New app idea"}\n```'
    const out = parseEnrichOutput(reply)
    expect(out?.title).toBe('New app idea')
  })

  it('returns null on non-JSON garbage', () => {
    expect(parseEnrichOutput('I could not understand that.')).toBeNull()
    expect(parseEnrichOutput('{ not valid json')).toBeNull()
  })

  it('returns null when required fields are missing (schema-fail)', () => {
    expect(parseEnrichOutput({ title: 'x' })).toBeNull()
  })
})

describe('parseSummaryOutput', () => {
  it('accepts an already-parsed object', () => {
    const out = parseSummaryOutput({ summary: 'Good week.' })
    expect(out?.summary).toBe('Good week.')
  })

  it('recovers JSON wrapped in prose / code fences', () => {
    const reply = 'Here:\n```json\n{"summary":"A calm week overall."}\n```'
    const out = parseSummaryOutput(reply)
    expect(out?.summary).toBe('A calm week overall.')
  })

  it('returns null on non-JSON garbage', () => {
    expect(parseSummaryOutput('I could not understand that.')).toBeNull()
    expect(parseSummaryOutput('{ not valid json')).toBeNull()
  })

  it('returns null when required fields are missing (schema-fail)', () => {
    expect(parseSummaryOutput({ highlights: ['x'] })).toBeNull()
  })
})

describe('coerceEnrichment', () => {
  const tz = 'America/Chicago'

  it('happy path: coerces a full raw enrichment', () => {
    const e = coerceEnrichment(
      rawEnrich({
        category: 'Work',
        title: 'Sprint planning',
        themes: ['planning', 'sprint'],
        entities: [{ name: 'Sam', kind: 'person' }],
        summary: 'Talked through the sprint.',
        tasks: [{ title: 'Follow up with Sam', date: '2026-08-25', time: null }],
        events: [{ title: 'Sprint review', date: '2026-08-27', time: '10:00', durationMinutes: 30 }],
      }),
      tz,
    )
    expect(e.category).toBe('Work')
    expect(e.title).toBe('Sprint planning')
    expect(e.themes).toEqual(['planning', 'sprint'])
    expect(e.entities).toEqual([{ name: 'Sam', kind: 'person' }])
    expect(e.summary).toBe('Talked through the sprint.')
    expect(e.taskSuggestions).toHaveLength(1)
    expect(e.eventSuggestions).toHaveLength(1)
  })

  it('falls back an unknown category to Other', () => {
    expect(coerceEnrichment(rawEnrich({ category: 'wishlist' }), tz).category).toBe('Other')
  })

  it('matches a known category case-insensitively', () => {
    expect(coerceEnrichment(rawEnrich({ category: 'work' }), tz).category).toBe('Work')
  })

  it('clamps title fallback and truncation', () => {
    expect(coerceEnrichment(rawEnrich({ title: '   ' }), tz).title).toBe('Brain dump')
    const long = 'a'.repeat(200)
    const e = coerceEnrichment(rawEnrich({ title: long }), tz)
    expect(e.title.length).toBeLessThanOrEqual(100)
    expect(e.title.endsWith('…')).toBe(true)
  })

  // --- themes: dedupe + clamp ---
  it('dedupes themes case-insensitively (keeping first casing) and clamps to MAX_THEMES', () => {
    const themes = ['Work', 'work', 'WORK', ...Array.from({ length: 15 }, (_, i) => `theme${i}`)]
    const e = coerceEnrichment(rawEnrich({ themes }), tz)
    expect(e.themes[0]).toBe('Work')
    expect(e.themes.filter((t) => t.toLowerCase() === 'work')).toHaveLength(1)
    expect(e.themes.length).toBeLessThanOrEqual(MAX_THEMES)
  })

  it('drops blank themes', () => {
    const e = coerceEnrichment(rawEnrich({ themes: ['  ', 'real'] }), tz)
    expect(e.themes).toEqual(['real'])
  })

  it('handles null themes', () => {
    expect(coerceEnrichment(rawEnrich({ themes: null }), tz).themes).toEqual([])
  })

  // --- entities: dedupe + kind fallback + clamp ---
  it('dedupes entities by kind+name and clamps to MAX_ENTITIES', () => {
    const entities = [
      { name: 'Sam', kind: 'person' },
      { name: 'sam', kind: 'person' },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `Entity${i}`, kind: 'topic' })),
    ]
    const e = coerceEnrichment(rawEnrich({ entities }), tz)
    expect(e.entities.filter((x) => x.name.toLowerCase() === 'sam')).toHaveLength(1)
    expect(e.entities.length).toBeLessThanOrEqual(MAX_ENTITIES)
  })

  it('dedupes entities by name alone across kinds, keeping the first occurrence\'s kind', () => {
    const e = coerceEnrichment(
      rawEnrich({
        entities: [
          { name: 'Trump', kind: 'person' },
          { name: 'trump', kind: 'topic' },
        ],
      }),
      tz,
    )
    expect(e.entities).toEqual([{ name: 'Trump', kind: 'person' }])
  })

  it('falls back an unknown/missing entity kind to topic', () => {
    const e = coerceEnrichment(
      rawEnrich({ entities: [{ name: 'Mystery', kind: 'alien' }, { name: 'NoKind' }] }),
      tz,
    )
    expect(e.entities).toEqual([
      { name: 'Mystery', kind: 'topic' },
      { name: 'NoKind', kind: 'topic' },
    ])
  })

  it('drops entities with a blank name', () => {
    const e = coerceEnrichment(rawEnrich({ entities: [{ name: '   ', kind: 'person' }] }), tz)
    expect(e.entities).toEqual([])
  })

  it('handles null entities', () => {
    expect(coerceEnrichment(rawEnrich({ entities: null }), tz).entities).toEqual([])
  })

  // --- summary: trim + clamp ---
  it('trims summary and clamps to MAX_ANALYSIS_SUMMARY', () => {
    const e = coerceEnrichment(rawEnrich({ summary: `  ${'a'.repeat(600)}  ` }), tz)
    expect(e.summary!.length).toBe(MAX_ANALYSIS_SUMMARY)
  })

  it('normalizes an empty or null summary to null', () => {
    expect(coerceEnrichment(rawEnrich({ summary: '   ' }), tz).summary).toBeNull()
    expect(coerceEnrichment(rawEnrich({ summary: null }), tz).summary).toBeNull()
    expect(coerceEnrichment(rawEnrich({}), tz).summary).toBeNull()
  })

  // --- task suggestions: title clamp + date/time -> dueDate ---
  it('clamps an over-long task title with an ellipsis', () => {
    const e = coerceEnrichment(rawEnrich({ tasks: [{ title: 'a'.repeat(200) }] }), tz)
    expect(e.taskSuggestions[0]!.title.length).toBeLessThanOrEqual(100)
    expect(e.taskSuggestions[0]!.title.endsWith('…')).toBe(true)
  })

  it('drops tasks with a blank title', () => {
    const e = coerceEnrichment(rawEnrich({ tasks: [{ title: '   ' }] }), tz)
    expect(e.taskSuggestions).toEqual([])
  })

  it('resolves a date-only task to a day-only dueDate', () => {
    const e = coerceEnrichment(rawEnrich({ tasks: [{ title: 'Call Sam', date: '2026-08-25', time: null }] }), tz)
    expect(e.taskSuggestions[0]!.dueDate).toBe('2026-08-25')
  })

  it('resolves a date+time task to a tz-anchored instant', () => {
    const e = coerceEnrichment(
      rawEnrich({ tasks: [{ title: 'Call Sam', date: '2026-08-25', time: '09:00' }] }),
      tz,
    )
    expect(e.taskSuggestions[0]!.dueDate).toBe('2026-08-25T14:00:00.000Z') // CDT, UTC-5
  })

  it('degrades a garbage task date to a null dueDate', () => {
    const e = coerceEnrichment(rawEnrich({ tasks: [{ title: 'x', date: '08/25/2026' }] }), tz)
    expect(e.taskSuggestions[0]!.dueDate).toBeNull()
  })

  it('clamps taskSuggestions to MAX_SUGGESTED_TASKS', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ title: `Task ${i}` }))
    const e = coerceEnrichment(rawEnrich({ tasks }), tz)
    expect(e.taskSuggestions.length).toBeLessThanOrEqual(MAX_SUGGESTED_TASKS)
  })

  it('handles null tasks', () => {
    expect(coerceEnrichment(rawEnrich({ tasks: null }), tz).taskSuggestions).toEqual([])
  })

  // --- event suggestions: no date skipped, date-only all-day, date+time+duration ---
  it('skips an event with no resolvable date', () => {
    const e = coerceEnrichment(rawEnrich({ events: [{ title: 'Mystery meeting' }] }), tz)
    expect(e.eventSuggestions).toEqual([])
  })

  it('treats a date-only event as all-day midnight instant', () => {
    const e = coerceEnrichment(rawEnrich({ events: [{ title: 'Trip', date: '2026-08-25' }] }), tz)
    expect(e.eventSuggestions[0]!.allDay).toBe(true)
    expect(e.eventSuggestions[0]!.startAt).toBe('2026-08-25T05:00:00.000Z') // local midnight, CDT
    expect(e.eventSuggestions[0]!.endAt).toBeNull()
  })

  it('resolves a date+time+duration event to startAt/endAt', () => {
    const e = coerceEnrichment(
      rawEnrich({
        events: [{ title: 'Sprint review', date: '2026-08-27', time: '10:00', durationMinutes: 30 }],
      }),
      tz,
    )
    expect(e.eventSuggestions[0]!.allDay).toBe(false)
    expect(e.eventSuggestions[0]!.startAt).toBe('2026-08-27T15:00:00.000Z')
    expect(e.eventSuggestions[0]!.endAt).toBe('2026-08-27T15:30:00.000Z')
  })

  it('clamps an oversized duration to 24h', () => {
    const e = coerceEnrichment(
      rawEnrich({
        events: [{ title: 'Marathon', date: '2026-08-27', time: '10:00', durationMinutes: 99999 }],
      }),
      tz,
    )
    const start = new Date(e.eventSuggestions[0]!.startAt!).getTime()
    const end = new Date(e.eventSuggestions[0]!.endAt!).getTime()
    expect(end - start).toBe(24 * 60 * 60 * 1000)
  })

  it('omits endAt when no duration is given', () => {
    const e = coerceEnrichment(
      rawEnrich({ events: [{ title: 'Sync', date: '2026-08-27', time: '10:00' }] }),
      tz,
    )
    expect(e.eventSuggestions[0]!.endAt).toBeNull()
  })

  it('clamps eventSuggestions to MAX_SUGGESTED_EVENTS', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ title: `Event ${i}`, date: '2026-08-27' }))
    const e = coerceEnrichment(rawEnrich({ events }), tz)
    expect(e.eventSuggestions.length).toBeLessThanOrEqual(MAX_SUGGESTED_EVENTS)
  })

  it('handles null events', () => {
    expect(coerceEnrichment(rawEnrich({ events: null }), tz).eventSuggestions).toEqual([])
  })
})

describe('coerceSummary', () => {
  it('happy path: coerces a full raw summary', () => {
    const s = coerceSummary(
      rawSummary({ summary: 'A productive week.', highlights: ['Shipped the feature'], moodTrend: 'Upbeat throughout.' }),
    )
    expect(s).toEqual({
      summary: 'A productive week.',
      highlights: ['Shipped the feature'],
      moodTrend: 'Upbeat throughout.',
    })
  })

  it('returns null when the summary text is empty', () => {
    expect(coerceSummary(rawSummary({ summary: '   ' }))).toBeNull()
  })

  it('trims and caps highlights at MAX_SUMMARY_HIGHLIGHTS', () => {
    const highlights = Array.from({ length: 12 }, (_, i) => `  point ${i}  `)
    const s = coerceSummary(rawSummary({ highlights }))
    expect(s!.highlights.length).toBe(MAX_SUMMARY_HIGHLIGHTS)
    expect(s!.highlights[0]).toBe('point 0')
  })

  it('drops blank highlights', () => {
    const s = coerceSummary(rawSummary({ highlights: ['  ', 'real point'] }))
    expect(s!.highlights).toEqual(['real point'])
  })

  it('handles null highlights', () => {
    const s = coerceSummary(rawSummary({ highlights: null }))
    expect(s!.highlights).toEqual([])
  })

  it('normalizes an empty or null moodTrend to null', () => {
    expect(coerceSummary(rawSummary({ moodTrend: '   ' }))!.moodTrend).toBeNull()
    expect(coerceSummary(rawSummary({ moodTrend: null }))!.moodTrend).toBeNull()
    expect(coerceSummary(rawSummary({}))!.moodTrend).toBeNull()
  })

  it('clamps an over-long summary to 2000 chars', () => {
    const s = coerceSummary(rawSummary({ summary: 'a'.repeat(2500) }))
    expect(s!.summary.length).toBe(2000)
  })
})

describe('encodeAiAnalysis / decodeAiAnalysis codec', () => {
  const payload = {
    themes: ['work', 'planning'],
    entities: [{ name: 'Sam', kind: 'person' as const }],
    summary: 'A short summary.',
    model: '@cf/mistral/mistral-7b-instruct-v0.2',
  }

  it('round-trips encode -> decode', () => {
    const encoded = encodeAiAnalysis(payload)
    const decoded = decodeAiAnalysis(encoded)
    expect(decoded).toEqual({ v: AI_ANALYSIS_VERSION, ...payload })
  })

  it('rejects malformed JSON', () => {
    expect(decodeAiAnalysis('{ not json')).toBeNull()
  })

  it('rejects a non-string / empty input', () => {
    expect(decodeAiAnalysis(undefined)).toBeNull()
    expect(decodeAiAnalysis(null)).toBeNull()
    expect(decodeAiAnalysis('')).toBeNull()
    expect(decodeAiAnalysis(42)).toBeNull()
  })

  it('rejects the wrong version', () => {
    const bad = JSON.stringify({ v: 2, themes: [], entities: [], summary: null, model: 'x' })
    expect(decodeAiAnalysis(bad)).toBeNull()
  })

  it('rejects an oversized value', () => {
    const huge = 'a'.repeat(10001)
    expect(decodeAiAnalysis(huge)).toBeNull()
  })

  it('rejects bad entity kinds', () => {
    const bad = JSON.stringify({
      v: AI_ANALYSIS_VERSION,
      themes: [],
      entities: [{ name: 'X', kind: 'alien' }],
      summary: null,
      model: 'x',
    })
    expect(decodeAiAnalysis(bad)).toBeNull()
  })
})
