import { describe, expect, it } from 'vitest'
import {
  dominantKind,
  dominantLabel,
  knownConceptLabels,
  normalizeConceptLabel,
  type ConceptKind,
} from './braindump-concepts.js'
import type { AiAnalysis, StreamEntry } from './braindump-helpers.js'

function analysis(over: Partial<AiAnalysis> = {}): AiAnalysis {
  return { v: 1, themes: [], entities: [], summary: null, model: 'claude-x', ...over }
}

function entry(over: Partial<StreamEntry> & { key: string }): StreamEntry {
  return {
    id: over.key,
    source: 'braindump',
    listId: null,
    title: 't',
    body: null,
    day: '',
    timed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    category: null,
    analysis: null,
    raw: null,
    ...over,
  }
}

describe('normalizeConceptLabel', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeConceptLabel('  Focus   Mode  ')).toBe('focus mode')
  })

  it('strips accents', () => {
    expect(normalizeConceptLabel('Café')).toBe('cafe')
  })

  it('strips surrounding punctuation', () => {
    expect(normalizeConceptLabel('"Focus!"')).toBe('focus')
  })

  it('strips a trailing possessive', () => {
    expect(normalizeConceptLabel("Trump's")).toBe('trump')
    expect(normalizeConceptLabel('Trump’s')).toBe('trump')
  })

  it('drops a leading article', () => {
    expect(normalizeConceptLabel('The Trump')).toBe('trump')
    expect(normalizeConceptLabel('a plan')).toBe('plan')
    expect(normalizeConceptLabel('an idea')).toBe('idea')
  })

  it('singularizes the last word only, conservatively', () => {
    expect(normalizeConceptLabel('skin issues')).toBe('skin issue')
    expect(normalizeConceptLabel('stories')).toBe('story')
    expect(normalizeConceptLabel('boxes')).toBe('box')
  })

  it('does not singularize words ending in ss/us/is/as or short words', () => {
    expect(normalizeConceptLabel('bus')).toBe('bus')
    expect(normalizeConceptLabel('analysis')).toBe('analysis')
    expect(normalizeConceptLabel('gas')).toBe('gas')
  })

  it('returns empty string for blank input', () => {
    expect(normalizeConceptLabel('')).toBe('')
    expect(normalizeConceptLabel('   ')).toBe('')
  })

  it('merges casing/accent/plural variants onto the same key', () => {
    expect(normalizeConceptLabel('Trump')).toBe(normalizeConceptLabel('trump'))
    expect(normalizeConceptLabel('Skin')).toBe(normalizeConceptLabel('skins'))
  })

  it('preserves non-Latin scripts instead of stripping them to empty', () => {
    expect(normalizeConceptLabel('Москва')).toBe('москва')
    expect(normalizeConceptLabel('東京')).toBe('東京')
  })

  it('does not over-singularize a short word ending in "ies"', () => {
    expect(normalizeConceptLabel('ties')).not.toBe('ty')
  })
})

describe('dominantKind', () => {
  it('picks the most-voted kind', () => {
    expect(dominantKind(['person', 'person', 'topic'])).toBe('person')
  })

  it('breaks ties by precedence: person > place > topic > theme', () => {
    expect(dominantKind(['topic', 'person'])).toBe('person')
    expect(dominantKind(['theme', 'place'])).toBe('place')
    expect(dominantKind(['theme', 'topic'])).toBe('topic')
  })

  it('is deterministic regardless of vote order', () => {
    const votes: ConceptKind[] = ['topic', 'person', 'topic', 'person']
    expect(dominantKind(votes)).toBe(dominantKind([...votes].reverse()))
  })
})

describe('dominantLabel', () => {
  it('picks the most frequent exact spelling', () => {
    expect(dominantLabel(['Trump', 'trump', 'Trump'])).toBe('Trump')
  })

  it('breaks a frequency tie by shortest label', () => {
    expect(dominantLabel(['Trumps', 'Trump'])).toBe('Trump')
  })

  it('breaks a shortest-length tie lexicographically (case-insensitive)', () => {
    expect(dominantLabel(['Zeta', 'Alfa'])).toBe('Alfa')
  })

  it('breaks a same-spelling tie by fewest capitals', () => {
    expect(dominantLabel(['FOCUS', 'Focus'])).toBe('Focus')
    expect(dominantLabel(['Trump', 'trump'])).toBe('trump')
  })

  it('is deterministic regardless of input order', () => {
    const labels = ['Trump', 'trump', 'TRUMP']
    expect(dominantLabel(labels)).toBe(dominantLabel([...labels].reverse()))
  })

  it('returns empty string for an empty input', () => {
    expect(dominantLabel([])).toBe('')
  })

  it('breaks a same-length/same-casefold/same-capital-count tie by codepoint order', () => {
    expect(dominantLabel(['AbC', 'ABc'])).toBe(dominantLabel(['ABc', 'AbC']))
  })
})

describe('knownConceptLabels', () => {
  it('weights by distinct entries, not raw mentions, and dedupes within an entry', () => {
    const e1 = entry({
      key: 'e1',
      analysis: analysis({ entities: [{ name: 'Trump', kind: 'person' }, { name: 'trump', kind: 'person' }] }),
    })
    const e2 = entry({ key: 'e2', analysis: analysis({ entities: [{ name: 'Trump', kind: 'topic' }] }) })
    expect(knownConceptLabels([e1, e2])).toEqual(['Trump'])
  })

  it('orders by count desc, then label asc, and caps at limit', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Alfa', 'Beta', 'Zeta'] }) })
    const e2 = entry({ key: 'e2', analysis: analysis({ themes: ['Alfa'] }) })
    expect(knownConceptLabels([e1, e2], 2)).toEqual(['Alfa', 'Beta'])
  })

  it('ignores entries without an analysis', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Focus'] }) })
    const e2 = entry({ key: 'e2', analysis: null })
    expect(knownConceptLabels([e1, e2])).toEqual(['Focus'])
  })

  it('returns an empty array for an empty stream', () => {
    expect(knownConceptLabels([])).toEqual([])
  })

  it('drops a label over 40 chars (entity names allow up to 80)', () => {
    const longName = 'A'.repeat(80)
    const e1 = entry({ key: 'e1', analysis: analysis({ entities: [{ name: longName, kind: 'person' }] }) })
    expect(knownConceptLabels([e1])).toEqual([])
  })

  it('collapses an internal newline to a single space', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Focus\nMode'] }) })
    expect(knownConceptLabels([e1])).toEqual(['Focus Mode'])
  })

  it('every returned label satisfies the API length cap (<= 40 chars)', () => {
    const e1 = entry({
      key: 'e1',
      analysis: analysis({
        themes: ['Focus', 'B'.repeat(45)],
        entities: [{ name: 'C'.repeat(90), kind: 'topic' }],
      }),
    })
    expect(knownConceptLabels([e1]).every((l) => l.length <= 40)).toBe(true)
  })
})
