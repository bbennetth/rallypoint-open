import { describe, it, expect } from 'vitest'
import {
  compareForSort,
  encodeFilterParam,
  encodeSortParam,
  evalFilter,
  opsForKind,
  parseListQuery,
  resolveQueryField,
  validateListQuery,
  type FieldDefForQuery,
} from './list-query.js'

const defs: FieldDefForQuery[] = [
  { id: 'lfd_budget', fieldType: 'number' },
  { id: 'lfd_store', fieldType: 'single_select' },
  { id: 'lfd_tags', fieldType: 'multi_select' },
  { id: 'lfd_due', fieldType: 'date' },
  { id: 'lfd_note', fieldType: 'text' },
]

describe('resolveQueryField', () => {
  it('maps built-in columns to their kind', () => {
    expect(resolveQueryField('title', defs)).toEqual({ field: 'title', source: 'builtin', kind: 'text' })
    expect(resolveQueryField('completed', defs)).toEqual({ field: 'completed', source: 'builtin', kind: 'bool' })
    expect(resolveQueryField('due_date', defs)).toEqual({ field: 'due_date', source: 'builtin', kind: 'date' })
  })

  it('maps a custom def id to the kind of its field type', () => {
    expect(resolveQueryField('lfd_budget', defs)?.kind).toBe('number')
    expect(resolveQueryField('lfd_store', defs)?.kind).toBe('select')
    expect(resolveQueryField('lfd_tags', defs)?.kind).toBe('multi')
  })

  it('returns null for an unknown field', () => {
    expect(resolveQueryField('lfd_ghost', defs)).toBeNull()
    expect(resolveQueryField('not_a_column', defs)).toBeNull()
  })
})

describe('opsForKind', () => {
  it('offers range ops for number but not for select', () => {
    expect(opsForKind('number')).toContain('gte')
    expect(opsForKind('select')).not.toContain('gte')
    expect(opsForKind('bool')).toEqual(['eq'])
    expect(opsForKind('multi')).toEqual(['has_any', 'is_empty'])
  })
})

describe('parseListQuery', () => {
  it('parses well-formed filter and sort params', () => {
    const q = parseListQuery(['lfd_budget:gte:10', 'status:eq:done'], ['priority:asc', 'lfd_budget:desc'])
    expect(q.filters).toEqual([
      { field: 'lfd_budget', op: 'gte', value: '10' },
      { field: 'status', op: 'eq', value: 'done' },
    ])
    expect(q.sort).toEqual([
      { field: 'priority', dir: 'asc' },
      { field: 'lfd_budget', dir: 'desc' },
    ])
  })

  it('parses a value-less is_empty filter', () => {
    expect(parseListQuery(['assigned_to:is_empty'], [])).toEqual({
      filters: [{ field: 'assigned_to', op: 'is_empty' }],
      sort: [],
    })
  })

  it('keeps colons inside a filter value', () => {
    expect(parseListQuery(['lfd_note:contains:a:b'], [])).toEqual({
      filters: [{ field: 'lfd_note', op: 'contains', value: 'a:b' }],
      sort: [],
    })
  })

  it('drops malformed params (bad op, bad dir, no separator)', () => {
    const q = parseListQuery(['lfd_budget:bogus:1', 'noseparator', ':eq:1'], ['title:sideways', 'nope'])
    expect(q).toEqual({ filters: [], sort: [] })
  })

  it('round-trips through encode', () => {
    expect(encodeFilterParam({ field: 'lfd_budget', op: 'gte', value: '10' })).toBe('lfd_budget:gte:10')
    expect(encodeFilterParam({ field: 'assigned_to', op: 'is_empty' })).toBe('assigned_to:is_empty')
    expect(encodeSortParam({ field: 'priority', dir: 'desc' })).toBe('priority:desc')
  })
})

describe('validateListQuery', () => {
  it('keeps valid specs and attaches the resolved field', () => {
    const { filters, sort } = validateListQuery(
      { filters: [{ field: 'lfd_budget', op: 'gte', value: '10' }], sort: [{ field: 'status', dir: 'asc' }] },
      defs,
    )
    expect(filters).toHaveLength(1)
    expect(filters[0]!.resolved.kind).toBe('number')
    expect(sort).toHaveLength(1)
    expect(sort[0]!.resolved.source).toBe('builtin')
  })

  it('drops a filter on an unknown field (stale-view tolerance)', () => {
    const { filters } = validateListQuery({ filters: [{ field: 'lfd_gone', op: 'eq', value: 'x' }], sort: [] }, defs)
    expect(filters).toEqual([])
  })

  it('drops a filter whose op is not allowed for the kind', () => {
    // number has no `contains`; multi has no `gt`
    const { filters } = validateListQuery(
      {
        filters: [
          { field: 'lfd_budget', op: 'contains', value: '1' },
          { field: 'lfd_tags', op: 'gt', value: 'x' },
        ],
        sort: [],
      },
      defs,
    )
    expect(filters).toEqual([])
  })

  it('drops a value-bearing op with a missing/empty value', () => {
    const { filters } = validateListQuery(
      { filters: [{ field: 'lfd_budget', op: 'gte' }, { field: 'lfd_note', op: 'eq', value: '' }], sort: [] },
      defs,
    )
    expect(filters).toEqual([])
  })

  it('drops a date filter whose value is not a parseable date (would 500 in pg)', () => {
    const { filters } = validateListQuery(
      {
        filters: [
          { field: 'lfd_due', op: 'gte', value: 'notadate' },
          { field: 'lfd_due', op: 'gte', value: '2026-01-01' },
        ],
        sort: [],
      },
      defs,
    )
    expect(filters).toHaveLength(1)
    expect(filters[0]!.value).toBe('2026-01-01')
  })

  it('drops a sort on a multi-select (no total order)', () => {
    const { sort } = validateListQuery({ filters: [], sort: [{ field: 'lfd_tags', dir: 'asc' }] }, defs)
    expect(sort).toEqual([])
  })
})

describe('evalFilter', () => {
  it('text: eq / neq / contains (case-insensitive) / is_empty', () => {
    expect(evalFilter('text', 'eq', 'Milk', 'Milk')).toBe(true)
    expect(evalFilter('text', 'neq', 'Milk', 'Eggs')).toBe(true)
    expect(evalFilter('text', 'contains', 'Whole Milk', 'milk')).toBe(true)
    expect(evalFilter('text', 'is_empty', '', undefined)).toBe(true)
    expect(evalFilter('text', 'is_empty', 'x', undefined)).toBe(false)
  })

  it('number: comparisons coerce and reject non-finite', () => {
    expect(evalFilter('number', 'gte', 10, '10')).toBe(true)
    expect(evalFilter('number', 'lt', 5, '10')).toBe(true)
    expect(evalFilter('number', 'eq', 3, '3')).toBe(true)
    expect(evalFilter('number', 'gt', null, '0')).toBe(false)
    expect(evalFilter('number', 'gt', 1, 'not-a-number')).toBe(false)
  })

  it('date: range compares on parsed timestamps', () => {
    const iso = new Date('2026-06-02').toISOString()
    expect(evalFilter('date', 'gte', iso, '2026-06-01')).toBe(true)
    expect(evalFilter('date', 'lt', iso, '2026-06-03')).toBe(true)
    expect(evalFilter('date', 'eq', iso, '2026-06-02')).toBe(true)
    expect(evalFilter('date', 'is_empty', null, undefined)).toBe(true)
  })

  it('bool: eq against true/false', () => {
    expect(evalFilter('bool', 'eq', true, 'true')).toBe(true)
    expect(evalFilter('bool', 'eq', false, 'false')).toBe(true)
    expect(evalFilter('bool', 'eq', true, 'false')).toBe(false)
  })

  it('select: eq / is_empty', () => {
    expect(evalFilter('select', 'eq', 'opt_a', 'opt_a')).toBe(true)
    expect(evalFilter('select', 'is_empty', null, undefined)).toBe(true)
  })

  it('multi: has_any membership / is_empty', () => {
    expect(evalFilter('multi', 'has_any', ['opt_x', 'opt_y'], 'opt_y')).toBe(true)
    expect(evalFilter('multi', 'has_any', ['opt_x'], 'opt_z')).toBe(false)
    expect(evalFilter('multi', 'is_empty', [], undefined)).toBe(true)
    expect(evalFilter('multi', 'is_empty', ['opt_x'], undefined)).toBe(false)
  })
})

describe('compareForSort', () => {
  it('orders numbers ascending and descending', () => {
    expect(compareForSort('number', 1, 2, 'asc')).toBeLessThan(0)
    expect(compareForSort('number', 1, 2, 'desc')).toBeGreaterThan(0)
  })

  it('orders text with locale compare', () => {
    expect(compareForSort('text', 'apple', 'banana', 'asc')).toBeLessThan(0)
  })

  it('puts nullish values last regardless of direction', () => {
    expect(compareForSort('number', null, 5, 'asc')).toBe(1)
    expect(compareForSort('number', null, 5, 'desc')).toBe(1)
    expect(compareForSort('text', 'x', '', 'asc')).toBeLessThan(0)
    expect(compareForSort('number', null, null, 'asc')).toBe(0)
  })
})
