import { describe, it, expect } from 'vitest'
import { normalizeViewConfig, viewConfigField } from './views.js'

describe('viewConfigField', () => {
  it('fills missing keys with the empty defaults', () => {
    const parsed = viewConfigField.parse({})
    expect(parsed).toEqual({ filters: [], sort: [], visibleColumns: [], viewMode: 'list' })
  })

  it('keeps a well-formed config', () => {
    const parsed = viewConfigField.parse({
      filters: [{ field: 'lfd_budget', op: 'gte', value: '10' }],
      sort: [{ field: 'title', dir: 'desc' }],
      visibleColumns: ['title', 'lfd_budget'],
      viewMode: 'grid',
    })
    expect(parsed).toEqual({
      filters: [{ field: 'lfd_budget', op: 'gte', value: '10' }],
      sort: [{ field: 'title', dir: 'desc' }],
      visibleColumns: ['title', 'lfd_budget'],
      viewMode: 'grid',
    })
  })

  it('keeps a value-less is_empty filter', () => {
    const parsed = viewConfigField.parse({ filters: [{ field: 'assigned_to', op: 'is_empty' }] })
    expect(parsed.filters).toEqual([{ field: 'assigned_to', op: 'is_empty' }])
  })

  it('rejects a filter with an unknown op', () => {
    expect(viewConfigField.safeParse({ filters: [{ field: 'title', op: 'bogus' }] }).success).toBe(
      false,
    )
  })

  it('rejects a bad view mode', () => {
    expect(viewConfigField.safeParse({ viewMode: 'kanban' }).success).toBe(false)
  })

  it('rejects a sort with a bad direction', () => {
    expect(
      viewConfigField.safeParse({ sort: [{ field: 'title', dir: 'sideways' }] }).success,
    ).toBe(false)
  })
})

describe('normalizeViewConfig', () => {
  it('returns the empty config for null/garbage input', () => {
    const empty = { filters: [], sort: [], visibleColumns: [], viewMode: 'list' }
    expect(normalizeViewConfig(null)).toEqual(empty)
    expect(normalizeViewConfig(undefined)).toEqual(empty)
    expect(normalizeViewConfig(42)).toEqual(empty)
    expect(normalizeViewConfig({ filters: [{ field: 'x', op: 'nope' }] })).toEqual(empty)
  })

  it('tolerates stale field names (existence resolved at apply time, not here)', () => {
    const parsed = normalizeViewConfig({
      filters: [{ field: 'lfd_deleted', op: 'eq', value: 'x' }],
      visibleColumns: ['lfd_also_gone'],
    })
    expect(parsed.filters).toEqual([{ field: 'lfd_deleted', op: 'eq', value: 'x' }])
    expect(parsed.visibleColumns).toEqual(['lfd_also_gone'])
  })
})
