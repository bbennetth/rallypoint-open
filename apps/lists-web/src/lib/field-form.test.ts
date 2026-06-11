import { describe, it, expect } from 'vitest'
import {
  activeChoices,
  fieldTypeHasChoices,
  fieldTypeLabel,
  missingRequiredFieldIds,
  multiValue,
  planFieldReorder,
  toggleSelection,
} from './field-form.js'
import type { FieldDefDto } from './api.js'

describe('fieldTypeLabel', () => {
  it('maps each field type to a human label', () => {
    expect(fieldTypeLabel('text')).toBe('Text')
    expect(fieldTypeLabel('single_select')).toBe('Single select')
    expect(fieldTypeLabel('multi_select')).toBe('Multi-select')
    expect(fieldTypeLabel('url')).toBe('URL')
  })
})

describe('fieldTypeHasChoices', () => {
  it('is true only for select types', () => {
    expect(fieldTypeHasChoices('single_select')).toBe(true)
    expect(fieldTypeHasChoices('multi_select')).toBe(true)
    expect(fieldTypeHasChoices('text')).toBe(false)
    expect(fieldTypeHasChoices('person')).toBe(false)
  })
})

describe('activeChoices', () => {
  it('hides archived choices but keeps live ones in order', () => {
    const def = {
      options: {
        choices: [
          { id: 'opt_a', label: 'A' },
          { id: 'opt_b', label: 'B', archived: true },
          { id: 'opt_c', label: 'C', archived: false },
        ],
      },
    }
    expect(activeChoices(def).map((c) => c.id)).toEqual(['opt_a', 'opt_c'])
  })

  it('returns an empty array when there are no choices', () => {
    expect(activeChoices({ options: {} })).toEqual([])
    expect(activeChoices({ options: { multiline: true } })).toEqual([])
  })
})

describe('planFieldReorder', () => {
  const defs: Pick<FieldDefDto, 'id' | 'position'>[] = [
    { id: 'lfd_1', position: 0 },
    { id: 'lfd_2', position: 1 },
    { id: 'lfd_3', position: 2 },
  ]

  it('swaps positions with the upward neighbour', () => {
    expect(planFieldReorder(defs, 1, -1)).toEqual([
      { id: 'lfd_2', position: 0 },
      { id: 'lfd_1', position: 1 },
    ])
  })

  it('swaps positions with the downward neighbour', () => {
    expect(planFieldReorder(defs, 1, 1)).toEqual([
      { id: 'lfd_2', position: 2 },
      { id: 'lfd_3', position: 1 },
    ])
  })

  it('returns null when moving up off the top', () => {
    expect(planFieldReorder(defs, 0, -1)).toBeNull()
  })

  it('returns null when moving down off the bottom', () => {
    expect(planFieldReorder(defs, 2, 1)).toBeNull()
  })

  it('preserves the actual position values when they are not 0,1,2', () => {
    const sparse: Pick<FieldDefDto, 'id' | 'position'>[] = [
      { id: 'lfd_a', position: 10 },
      { id: 'lfd_b', position: 25 },
    ]
    expect(planFieldReorder(sparse, 0, 1)).toEqual([
      { id: 'lfd_a', position: 25 },
      { id: 'lfd_b', position: 10 },
    ])
  })
})

describe('multiValue', () => {
  it('returns the string array as-is', () => {
    expect(multiValue(['opt_a', 'opt_b'])).toEqual(['opt_a', 'opt_b'])
  })

  it('returns an empty array for absent or non-array values', () => {
    expect(multiValue(undefined)).toEqual([])
    expect(multiValue(null)).toEqual([])
    expect(multiValue('opt_a')).toEqual([])
  })

  it('drops non-string members defensively', () => {
    expect(multiValue(['opt_a', 3, null, 'opt_b'])).toEqual(['opt_a', 'opt_b'])
  })
})

describe('missingRequiredFieldIds', () => {
  const req = (id: string): Pick<FieldDefDto, 'id' | 'required'> => ({ id, required: true })
  const opt = (id: string): Pick<FieldDefDto, 'id' | 'required'> => ({ id, required: false })

  it('returns [] when there are no required fields', () => {
    expect(missingRequiredFieldIds([opt('lfd_a'), opt('lfd_b')], {})).toEqual([])
  })

  it('reports a required field that is absent, null, or empty string', () => {
    const defs = [req('lfd_a'), req('lfd_b'), req('lfd_c')]
    expect(missingRequiredFieldIds(defs, { lfd_b: null, lfd_c: '' })).toEqual([
      'lfd_a',
      'lfd_b',
      'lfd_c',
    ])
  })

  it('does not report a required field that has a value', () => {
    expect(missingRequiredFieldIds([req('lfd_a')], { lfd_a: 'hello' })).toEqual([])
  })

  it('treats a false checkbox as set (not missing)', () => {
    expect(missingRequiredFieldIds([req('lfd_a')], { lfd_a: false })).toEqual([])
  })

  it('treats 0 as set (not missing)', () => {
    expect(missingRequiredFieldIds([req('lfd_a')], { lfd_a: 0 })).toEqual([])
  })

  it('reports an empty multi-select array but not a populated one', () => {
    expect(missingRequiredFieldIds([req('lfd_a')], { lfd_a: [] })).toEqual(['lfd_a'])
    expect(missingRequiredFieldIds([req('lfd_a')], { lfd_a: ['opt_x'] })).toEqual([])
  })

  it('ignores unset optional fields', () => {
    expect(missingRequiredFieldIds([req('lfd_a'), opt('lfd_b')], { lfd_a: 'x' })).toEqual([])
  })
})

describe('toggleSelection', () => {
  it('appends a choice that is not selected', () => {
    expect(toggleSelection(['opt_a'], 'opt_b')).toEqual(['opt_a', 'opt_b'])
  })

  it('removes a choice that is already selected, keeping the rest in order', () => {
    expect(toggleSelection(['opt_a', 'opt_b', 'opt_c'], 'opt_b')).toEqual(['opt_a', 'opt_c'])
  })

  it('does not mutate the input array', () => {
    const input = ['opt_a']
    toggleSelection(input, 'opt_b')
    expect(input).toEqual(['opt_a'])
  })
})
