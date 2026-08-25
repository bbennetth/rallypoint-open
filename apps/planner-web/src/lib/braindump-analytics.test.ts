import { describe, expect, it } from 'vitest'
import {
  SUMMARY_MAX_ENTRIES,
  SUMMARY_MAX_ENTRY_CHARS,
  SUMMARY_MAX_TOTAL_CHARS,
  categoryDistribution,
  entriesPerWeek,
  isoWeekOf,
  selectEntriesForSummary,
  topThemes,
} from './braindump-analytics.js'
import { UNCATEGORIZED, type AiAnalysis, type StreamEntry } from './braindump-helpers.js'

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

describe('categoryDistribution', () => {
  it('sorts by count descending, label as tiebreak', () => {
    const entries = [
      entry({ key: '1', category: 'Home' }),
      entry({ key: '2', category: 'Work' }),
      entry({ key: '3', category: 'Work' }),
      entry({ key: '4', category: 'Ideas' }),
    ]
    expect(categoryDistribution(entries)).toEqual([
      { category: 'Work', count: 2 },
      { category: 'Home', count: 1 },
      { category: 'Ideas', count: 1 },
    ])
  })

  it('places UNCATEGORIZED last even when it has the highest count', () => {
    const entries = [
      entry({ key: '1', category: null }),
      entry({ key: '2', category: null }),
      entry({ key: '3', category: 'Work' }),
    ]
    expect(categoryDistribution(entries)).toEqual([
      { category: 'Work', count: 1 },
      { category: UNCATEGORIZED, count: 2 },
    ])
  })

  it('omits UNCATEGORIZED entirely when no rows are uncategorized', () => {
    const entries = [entry({ key: '1', category: 'Work' })]
    expect(categoryDistribution(entries)).toEqual([{ category: 'Work', count: 1 }])
  })

  it('returns an empty array for an empty stream', () => {
    expect(categoryDistribution([])).toEqual([])
  })
})

describe('topThemes', () => {
  it('dedupes case-insensitively across entries, first casing wins', () => {
    const entries = [
      entry({ key: '1', analysis: analysis({ themes: ['Focus'] }) }),
      entry({ key: '2', analysis: analysis({ themes: ['FOCUS', 'Rest'] }) }),
    ]
    expect(topThemes(entries)).toEqual([
      { theme: 'Focus', count: 2 },
      { theme: 'Rest', count: 1 },
    ])
  })

  it('dedupes a repeated theme within one entry', () => {
    const entries = [entry({ key: '1', analysis: analysis({ themes: ['Focus', 'focus'] }) })]
    expect(topThemes(entries)).toEqual([{ theme: 'Focus', count: 1 }])
  })

  it('ignores entries without an analysis', () => {
    const entries = [
      entry({ key: '1', analysis: analysis({ themes: ['Focus'] }) }),
      entry({ key: '2', analysis: null }),
    ]
    expect(topThemes(entries)).toEqual([{ theme: 'Focus', count: 1 }])
  })

  it('caps results at the given limit', () => {
    const entries = [
      entry({ key: '1', analysis: analysis({ themes: ['A', 'B', 'C'] }) }),
    ]
    expect(topThemes(entries, 2)).toHaveLength(2)
  })
})

describe('isoWeekOf', () => {
  it('resolves known ISO week fixtures', () => {
    expect(isoWeekOf('2026-01-01')).toBe('2026-W01')
    expect(isoWeekOf('2026-06-15')).toBe('2026-W25')
    expect(isoWeekOf('2025-01-01')).toBe('2025-W01')
  })

  it('handles the year-boundary case (a date that belongs to the next ISO year)', () => {
    expect(isoWeekOf('2027-01-01')).toBe('2026-W53')
    expect(isoWeekOf('2026-12-31')).toBe('2026-W53')
  })

  it('returns null for garbage input', () => {
    expect(isoWeekOf('')).toBeNull()
    expect(isoWeekOf('not-a-date')).toBeNull()
    expect(isoWeekOf('2026-06')).toBeNull()
  })
})

describe('entriesPerWeek', () => {
  it('buckets by ISO week, most recent first', () => {
    const entries = [
      entry({ key: '1', day: '2026-01-01' }),
      entry({ key: '2', day: '2026-06-15' }),
      entry({ key: '3', day: '2026-06-16' }),
    ]
    expect(entriesPerWeek(entries)).toEqual([
      { week: '2026-W25', count: 2 },
      { week: '2026-W01', count: 1 },
    ])
  })

  it('skips undated rows', () => {
    const entries = [entry({ key: '1', day: '' }), entry({ key: '2', day: '2026-01-01' })]
    expect(entriesPerWeek(entries)).toEqual([{ week: '2026-W01', count: 1 }])
  })
})

describe('selectEntriesForSummary', () => {
  it('skips undated and empty entries, uses body else title', () => {
    const entries = [
      entry({ key: '1', day: '', title: 'x', body: 'ignored' }),
      entry({ key: '2', day: '2026-06-01', title: '', body: '' }),
      entry({ key: '3', day: '2026-06-02', title: 'Fallback title', body: null }),
      entry({ key: '4', day: '2026-06-03', title: 'ignored', body: 'Real body' }),
    ]
    const out = selectEntriesForSummary(entries)
    expect(out).toEqual([
      { date: '2026-06-02', category: null, text: 'Fallback title' },
      { date: '2026-06-03', category: null, text: 'Real body' },
    ])
  })

  it('selects the newest entries first, then outputs chronologically', () => {
    const entries = [
      entry({ key: '1', day: '2026-06-01', body: 'first' }),
      entry({ key: '2', day: '2026-06-03', body: 'third' }),
      entry({ key: '3', day: '2026-06-02', body: 'second' }),
    ]
    expect(selectEntriesForSummary(entries).map((e) => e.text)).toEqual(['first', 'second', 'third'])
  })

  it('caps at SUMMARY_MAX_ENTRIES, keeping the newest', () => {
    const entries: StreamEntry[] = []
    for (let i = 1; i <= SUMMARY_MAX_ENTRIES + 10; i++) {
      entries.push(
        entry({
          key: `e${i}`,
          day: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
          body: `entry-${i}`,
        }),
      )
    }
    const out = selectEntriesForSummary(entries)
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_ENTRIES)
  })

  it('truncates a single entry body at SUMMARY_MAX_ENTRY_CHARS', () => {
    const long = 'x'.repeat(SUMMARY_MAX_ENTRY_CHARS + 500)
    const entries = [entry({ key: '1', day: '2026-06-01', body: long })]
    const out = selectEntriesForSummary(entries)
    expect(out[0]?.text.length).toBe(SUMMARY_MAX_ENTRY_CHARS)
  })

  it('stops adding entries once SUMMARY_MAX_TOTAL_CHARS would be exceeded', () => {
    const chunk = 'x'.repeat(SUMMARY_MAX_ENTRY_CHARS)
    const count = Math.ceil(SUMMARY_MAX_TOTAL_CHARS / SUMMARY_MAX_ENTRY_CHARS) + 5
    const entries: StreamEntry[] = []
    for (let i = 0; i < count; i++) {
      entries.push(
        entry({
          key: `e${i}`,
          day: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
          body: chunk,
        }),
      )
    }
    const out = selectEntriesForSummary(entries)
    const total = out.reduce((sum, e) => sum + e.text.length, 0)
    expect(total).toBeLessThanOrEqual(SUMMARY_MAX_TOTAL_CHARS)
    expect(out.length).toBeLessThan(count)
  })

  it('carries the category through', () => {
    const entries = [entry({ key: '1', day: '2026-06-01', body: 'text', category: 'Work' })]
    expect(selectEntriesForSummary(entries)[0]?.category).toBe('Work')
  })
})
