import { describe, expect, it } from 'vitest'
import {
  UNCATEGORIZED,
  buildStream,
  categoriesInStream,
  decodeAiAnalysis,
  decodeAnalysisFromCustomFields,
  encodeAiAnalysis,
  filterByCategory,
  findAnalysisField,
  findCategoryField,
  fromBraindumpItem,
  fromDiaryItem,
  fromNote,
  sortStream,
  type StreamEntry,
} from './braindump-helpers.js'
import type { BraindumpEntryDto, DiaryEntryDto, FieldDefDto, NoteDto } from './api.js'

function def(over: Partial<FieldDefDto> & { id: string }): FieldDefDto {
  return {
    listId: 'lst_d',
    key: 'k',
    label: 'Field',
    fieldType: 'text',
    options: {},
    required: false,
    defaultValue: null,
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function item(over: Partial<BraindumpEntryDto> & { id: string }): BraindumpEntryDto {
  return {
    listId: 'lst_bd',
    title: 'Dump title',
    notes: null,
    completed: false,
    status: null,
    priority: null,
    dueDate: null,
    position: 0,
    seriesId: null,
    customFields: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function note(over: Partial<NoteDto> & { id: string }): NoteDto {
  return {
    title: 'Note title',
    notes: null,
    completed: false,
    completedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    folderId: 'fold_1',
    ...over,
  }
}

const categoryField = def({
  id: 'lfd_cat',
  label: 'Category',
  fieldType: 'single_select',
  options: { choices: [{ id: 'opt_work', label: 'Work' }, { id: 'opt_home', label: 'Home' }] },
})

const analysisField = def({ id: 'lfd_ai', label: 'AI Analysis', fieldType: 'text' })

const validAnalysisPayload = {
  themes: ['Focus', 'Rest'],
  entities: [{ name: 'Alice', kind: 'person' as const }],
  summary: 'A short summary',
  model: 'claude-x',
}

describe('findCategoryField / findAnalysisField', () => {
  it('finds by exact label + type', () => {
    expect(findCategoryField([def({ id: 'lfd_x' }), categoryField])?.id).toBe('lfd_cat')
    expect(findAnalysisField([def({ id: 'lfd_x' }), analysisField])?.id).toBe('lfd_ai')
  })

  it('ignores a same-label field of the wrong type', () => {
    expect(findCategoryField([def({ id: 'lfd_c', label: 'Category', fieldType: 'text' })])).toBeNull()
    expect(
      findAnalysisField([def({ id: 'lfd_a', label: 'AI Analysis', fieldType: 'single_select' })]),
    ).toBeNull()
  })

  it('returns null when absent', () => {
    expect(findCategoryField([def({ id: 'lfd_x' })])).toBeNull()
    expect(findAnalysisField([def({ id: 'lfd_x' })])).toBeNull()
  })
})

describe('decodeAiAnalysis / encodeAiAnalysis', () => {
  it('round-trips a valid payload', () => {
    const encoded = encodeAiAnalysis(validAnalysisPayload)
    expect(decodeAiAnalysis(encoded)).toEqual({ v: 1, ...validAnalysisPayload })
  })

  it('round-trips a null summary', () => {
    const encoded = encodeAiAnalysis({ ...validAnalysisPayload, summary: null })
    expect(decodeAiAnalysis(encoded)).toEqual({ v: 1, ...validAnalysisPayload, summary: null })
  })

  it('rejects non-string input', () => {
    expect(decodeAiAnalysis(null)).toBeNull()
    expect(decodeAiAnalysis(undefined)).toBeNull()
    expect(decodeAiAnalysis(42)).toBeNull()
    expect(decodeAiAnalysis({})).toBeNull()
  })

  it('rejects the empty string', () => {
    expect(decodeAiAnalysis('')).toBeNull()
  })

  it('rejects strings over 10000 chars', () => {
    const huge = JSON.stringify({ v: 1, ...validAnalysisPayload, summary: 'x'.repeat(10050) })
    expect(huge.length).toBeGreaterThan(10000)
    expect(decodeAiAnalysis(huge)).toBeNull()
  })

  it('rejects malformed JSON', () => {
    expect(decodeAiAnalysis('{not json')).toBeNull()
  })

  it('rejects a wrong version', () => {
    expect(decodeAiAnalysis(JSON.stringify({ v: 2, ...validAnalysisPayload }))).toBeNull()
    expect(decodeAiAnalysis(JSON.stringify({ ...validAnalysisPayload }))).toBeNull()
  })

  it('rejects bad themes', () => {
    expect(decodeAiAnalysis(JSON.stringify({ v: 1, ...validAnalysisPayload, themes: 'nope' }))).toBeNull()
    expect(
      decodeAiAnalysis(JSON.stringify({ v: 1, ...validAnalysisPayload, themes: ['ok', 5] })),
    ).toBeNull()
  })

  it('rejects a bad entity kind', () => {
    expect(
      decodeAiAnalysis(
        JSON.stringify({ v: 1, ...validAnalysisPayload, entities: [{ name: 'Bob', kind: 'alien' }] }),
      ),
    ).toBeNull()
  })

  it('rejects a bad entity name', () => {
    expect(
      decodeAiAnalysis(
        JSON.stringify({ v: 1, ...validAnalysisPayload, entities: [{ name: '', kind: 'person' }] }),
      ),
    ).toBeNull()
    expect(
      decodeAiAnalysis(
        JSON.stringify({ v: 1, ...validAnalysisPayload, entities: [{ name: 5, kind: 'person' }] }),
      ),
    ).toBeNull()
  })

  it('rejects entities that are not an array', () => {
    expect(decodeAiAnalysis(JSON.stringify({ v: 1, ...validAnalysisPayload, entities: {} }))).toBeNull()
  })

  it('rejects a missing model', () => {
    const { model: _model, ...rest } = validAnalysisPayload
    expect(decodeAiAnalysis(JSON.stringify({ v: 1, ...rest }))).toBeNull()
    expect(decodeAiAnalysis(JSON.stringify({ v: 1, ...rest, model: 5 }))).toBeNull()
  })

  it('rejects a non-string, non-null summary', () => {
    expect(
      decodeAiAnalysis(JSON.stringify({ v: 1, ...validAnalysisPayload, summary: 5 })),
    ).toBeNull()
  })
})

describe('fromBraindumpItem', () => {
  it('resolves category via the field def and decodes analysis', () => {
    const analysisRaw = encodeAiAnalysis(validAnalysisPayload)
    const it1 = item({
      id: 'bd1',
      customFields: { lfd_cat: 'opt_work', lfd_ai: analysisRaw },
    })
    const entry = fromBraindumpItem(it1, categoryField, analysisField)
    expect(entry.category).toBe('Work')
    expect(entry.analysis).toEqual({ v: 1, ...validAnalysisPayload })
    expect(entry.source).toBe('braindump')
    expect(entry.key).toBe('braindump:bd1')
  })

  it('yields null category/analysis when fields are absent', () => {
    const entry = fromBraindumpItem(item({ id: 'bd2' }), null, null)
    expect(entry.category).toBeNull()
    expect(entry.analysis).toBeNull()
  })

  it('derives day/timed from a day-only dueDate', () => {
    const entry = fromBraindumpItem(
      item({ id: 'bd3', dueDate: '2026-06-01T00:00:00.000Z' }),
      null,
      null,
    )
    expect(entry.day).toBe('2026-06-01')
    expect(entry.timed).toBe(false)
  })

  it('derives day/timed from a timed dueDate', () => {
    const entry = fromBraindumpItem(
      item({ id: 'bd4', dueDate: '2026-06-01T15:30:00.000Z' }),
      null,
      null,
    )
    expect(entry.timed).toBe(true)
  })

  it('handles an undated item', () => {
    const entry = fromBraindumpItem(item({ id: 'bd5', dueDate: null }), null, null)
    expect(entry.day).toBe('')
    expect(entry.timed).toBe(false)
  })
})

describe('decodeAnalysisFromCustomFields', () => {
  it('finds a valid blob among unrelated string/number custom fields', () => {
    const analysisRaw = encodeAiAnalysis(validAnalysisPayload)
    expect(
      decodeAnalysisFromCustomFields({ lfd_mood: 'okay', lfd_count: 3, lfd_ai: analysisRaw }),
    ).toEqual({ v: 1, ...validAnalysisPayload })
  })

  it('returns null for an empty, undefined or null map', () => {
    expect(decodeAnalysisFromCustomFields({})).toBeNull()
    expect(decodeAnalysisFromCustomFields(undefined)).toBeNull()
    expect(decodeAnalysisFromCustomFields(null)).toBeNull()
  })

  it('returns null when every value is malformed JSON or the wrong version', () => {
    expect(decodeAnalysisFromCustomFields({ lfd_a: '{not json', lfd_b: 5 })).toBeNull()
    expect(
      decodeAnalysisFromCustomFields({
        lfd_a: JSON.stringify({ v: 2, ...validAnalysisPayload }),
      }),
    ).toBeNull()
  })
})

describe('fromDiaryItem / fromNote', () => {
  it('maps a diary item with null category/analysis', () => {
    const dItem: DiaryEntryDto = item({ id: 'd1', dueDate: '2026-06-02T00:00:00.000Z' })
    const entry = fromDiaryItem(dItem)
    expect(entry.source).toBe('diary')
    expect(entry.key).toBe('diary:d1')
    expect(entry.category).toBeNull()
    expect(entry.analysis).toBeNull()
    expect(entry.day).toBe('2026-06-02')
  })

  it('surfaces analysis decoded from a diary item customFields, still null without one', () => {
    const analysisRaw = encodeAiAnalysis(validAnalysisPayload)
    const withAnalysis = fromDiaryItem(
      item({ id: 'd2', customFields: { lfd_ai: analysisRaw } }) as DiaryEntryDto,
    )
    expect(withAnalysis.analysis).toEqual({ v: 1, ...validAnalysisPayload })

    const without = fromDiaryItem(item({ id: 'd3' }) as DiaryEntryDto)
    expect(without.analysis).toBeNull()
  })

  it('maps a note using createdAt as the day, listId null', () => {
    const n = note({ id: 'n1', createdAt: '2026-06-03T12:00:00.000Z' })
    const entry = fromNote(n)
    expect(entry.source).toBe('note')
    expect(entry.key).toBe('note:n1')
    expect(entry.listId).toBeNull()
    expect(entry.day).toBe('2026-06-03')
    expect(entry.timed).toBe(false)
    expect(entry.category).toBeNull()
    expect(entry.analysis).toBeNull()
  })
})

function streamEntry(over: Partial<StreamEntry> & { key: string }): StreamEntry {
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

describe('sortStream', () => {
  it('orders newest day first', () => {
    const a = streamEntry({ key: 'a', day: '2026-06-01' })
    const b = streamEntry({ key: 'b', day: '2026-06-10' })
    const c = streamEntry({ key: 'c', day: '2026-06-05' })
    expect(sortStream([a, b, c]).map((e) => e.key)).toEqual(['b', 'c', 'a'])
  })

  it('sinks undated rows below dated ones', () => {
    const dated = streamEntry({ key: 'dated', day: '2026-06-01' })
    const undated = streamEntry({ key: 'undated', day: '' })
    expect(sortStream([undated, dated]).map((e) => e.key)).toEqual(['dated', 'undated'])
  })

  it('breaks same-day ties by createdAt, newest first', () => {
    const older = streamEntry({ key: 'older', day: '2026-06-01', createdAt: '2026-06-01T08:00:00.000Z' })
    const newer = streamEntry({ key: 'newer', day: '2026-06-01', createdAt: '2026-06-01T20:00:00.000Z' })
    expect(sortStream([older, newer]).map((e) => e.key)).toEqual(['newer', 'older'])
  })
})

describe('buildStream', () => {
  it('merges braindump, diary and notes into one sorted stream', () => {
    const bd = item({ id: 'bd1', dueDate: '2026-06-10T00:00:00.000Z' })
    const diary = item({ id: 'd1', dueDate: '2026-06-05T00:00:00.000Z' }) as DiaryEntryDto
    const n = note({ id: 'n1', createdAt: '2026-06-15T00:00:00.000Z' })
    const stream = buildStream([bd], [diary], [n], null, null)
    expect(stream.map((e) => e.key)).toEqual(['note:n1', 'braindump:bd1', 'diary:d1'])
  })
})

describe('filterByCategory', () => {
  const workEntry = streamEntry({ key: 'w', category: 'Work' })
  const homeEntry = streamEntry({ key: 'h', category: 'Home' })
  const bare = streamEntry({ key: 'b', category: null })
  const all = [workEntry, homeEntry, bare]

  it('returns all entries when category is null', () => {
    expect(filterByCategory(all, null).map((e) => e.key)).toEqual(['w', 'h', 'b'])
  })

  it('matches UNCATEGORIZED to category-less rows', () => {
    expect(filterByCategory(all, UNCATEGORIZED).map((e) => e.key)).toEqual(['b'])
  })

  it('matches a named category exactly', () => {
    expect(filterByCategory(all, 'Work').map((e) => e.key)).toEqual(['w'])
  })
})

describe('categoriesInStream', () => {
  it('returns categories in first-occurrence order', () => {
    const entries = [
      streamEntry({ key: '1', category: 'Home' }),
      streamEntry({ key: '2', category: 'Work' }),
      streamEntry({ key: '3', category: 'Home' }),
    ]
    expect(categoriesInStream(entries)).toEqual(['Home', 'Work'])
  })

  it('appends UNCATEGORIZED only when the stream is mixed', () => {
    const mixed = [streamEntry({ key: '1', category: 'Home' }), streamEntry({ key: '2', category: null })]
    expect(categoriesInStream(mixed)).toEqual(['Home', UNCATEGORIZED])

    const allCategorized = [streamEntry({ key: '1', category: 'Home' })]
    expect(categoriesInStream(allCategorized)).toEqual(['Home'])

    const allUncategorized = [streamEntry({ key: '1', category: null })]
    expect(categoriesInStream(allUncategorized)).toEqual([])
  })

  it('returns an empty array for an empty stream', () => {
    expect(categoriesInStream([])).toEqual([])
  })
})
