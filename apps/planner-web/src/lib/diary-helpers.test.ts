import { describe, expect, it } from 'vitest'
import {
  choiceLabel,
  dataPointFields,
  findMoodField,
  formatEntryDate,
  formatFieldValue,
  sortDiaryEntries,
  ymdFromDueDate,
} from './diary-helpers.js'
import type { DiaryEntryDto, FieldDefDto } from './api.js'

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

function entry(over: Partial<DiaryEntryDto> & { id: string }): DiaryEntryDto {
  return {
    listId: 'lst_d',
    title: 'Jun 1, 2026',
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

const moodDef = def({
  id: 'lfd_mood',
  label: 'Mood',
  fieldType: 'single_select',
  options: { choices: [{ id: 'opt_a', label: '😞 Rough' }, { id: 'opt_b', label: '😄 Great' }] },
})

describe('findMoodField', () => {
  it('finds the single_select labelled "Mood"', () => {
    expect(findMoodField([def({ id: 'lfd_x' }), moodDef])?.id).toBe('lfd_mood')
  })

  it('ignores a "Mood" field of the wrong type', () => {
    expect(findMoodField([def({ id: 'lfd_m', label: 'Mood', fieldType: 'text' })])).toBeNull()
  })

  it('returns null when absent', () => {
    expect(findMoodField([def({ id: 'lfd_x' })])).toBeNull()
  })
})

describe('dataPointFields', () => {
  it('excludes the mood field and sorts by position', () => {
    const a = def({ id: 'lfd_a', label: 'Sleep', position: 2 })
    const b = def({ id: 'lfd_b', label: 'Energy', position: 1 })
    const result = dataPointFields([a, moodDef, b])
    expect(result.map((d) => d.id)).toEqual(['lfd_b', 'lfd_a'])
  })

  it('returns all fields when there is no mood field', () => {
    const a = def({ id: 'lfd_a', position: 1 })
    expect(dataPointFields([a]).map((d) => d.id)).toEqual(['lfd_a'])
  })
})

describe('sortDiaryEntries', () => {
  it('orders newest entry-day first', () => {
    const e1 = entry({ id: 'e1', dueDate: '2026-06-01T00:00:00.000Z' })
    const e2 = entry({ id: 'e2', dueDate: '2026-06-10T00:00:00.000Z' })
    const e3 = entry({ id: 'e3', dueDate: '2026-06-05T00:00:00.000Z' })
    expect(sortDiaryEntries([e1, e2, e3]).map((e) => e.id)).toEqual(['e2', 'e3', 'e1'])
  })

  it('sinks undated entries below dated ones', () => {
    const dated = entry({ id: 'dated', dueDate: '2026-06-01T00:00:00.000Z' })
    const undated = entry({ id: 'undated', dueDate: null })
    expect(sortDiaryEntries([undated, dated]).map((e) => e.id)).toEqual(['dated', 'undated'])
  })

  it('breaks same-day ties by createdAt (newest first)', () => {
    const older = entry({ id: 'older', dueDate: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T08:00:00.000Z' })
    const newer = entry({ id: 'newer', dueDate: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T20:00:00.000Z' })
    expect(sortDiaryEntries([older, newer]).map((e) => e.id)).toEqual(['newer', 'older'])
  })

  it('does not mutate the input', () => {
    const input = [entry({ id: 'a', dueDate: '2026-06-01T00:00:00.000Z' }), entry({ id: 'b', dueDate: '2026-06-02T00:00:00.000Z' })]
    sortDiaryEntries(input)
    expect(input.map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('choiceLabel', () => {
  it('resolves a choice id to its label', () => {
    expect(choiceLabel(moodDef, 'opt_b')).toBe('😄 Great')
  })

  it('returns null for an unknown id, null value, or null field', () => {
    expect(choiceLabel(moodDef, 'opt_missing')).toBeNull()
    expect(choiceLabel(moodDef, null)).toBeNull()
    expect(choiceLabel(null, 'opt_a')).toBeNull()
  })
})

describe('formatFieldValue', () => {
  const multi = def({
    id: 'lfd_tags',
    label: 'Tags',
    fieldType: 'multi_select',
    options: { choices: [{ id: 'opt_a', label: 'Calm' }, { id: 'opt_b', label: 'Tired' }] },
  })

  it('resolves a single_select id to its label', () => {
    expect(formatFieldValue(moodDef, 'opt_b')).toBe('😄 Great')
  })

  it('joins multi_select array values', () => {
    expect(formatFieldValue(multi, ['opt_a', 'opt_b'])).toBe('Calm, Tired')
  })

  it('handles a multi_select stored as a single id', () => {
    expect(formatFieldValue(multi, 'opt_a')).toBe('Calm')
  })

  it('shows a ticked checkbox only', () => {
    const cb = def({ id: 'lfd_cb', fieldType: 'checkbox' })
    expect(formatFieldValue(cb, true)).toBe('Yes')
    expect(formatFieldValue(cb, false)).toBeNull()
  })

  it('stringifies number/text and skips empty', () => {
    expect(formatFieldValue(def({ id: 'lfd_n', fieldType: 'number' }), 7)).toBe('7')
    expect(formatFieldValue(def({ id: 'lfd_t', fieldType: 'text' }), 'hi')).toBe('hi')
    expect(formatFieldValue(def({ id: 'lfd_t2', fieldType: 'text' }), '')).toBeNull()
    expect(formatFieldValue(def({ id: 'lfd_t3', fieldType: 'text' }), null)).toBeNull()
  })
})

describe('ymdFromDueDate', () => {
  it('slices the UTC date part', () => {
    expect(ymdFromDueDate('2026-06-13T00:00:00.000Z')).toBe('2026-06-13')
  })

  it('returns empty string for null', () => {
    expect(ymdFromDueDate(null)).toBe('')
  })
})

describe('formatEntryDate', () => {
  it('formats a YMD in UTC', () => {
    // Deterministic across runner timezones (formatted in UTC).
    expect(formatEntryDate('2026-06-13')).toContain('Jun')
    expect(formatEntryDate('2026-06-13')).toContain('2026')
  })

  it('labels an empty date', () => {
    expect(formatEntryDate('')).toBe('No date')
  })
})
