import { describe, it, expect } from 'vitest'
import { isPlannerManaged, partitionByOrigin, resolvePlannerReadOnly } from './list-origin.js'
import type { ListType } from '@rallypoint/lists-shared'

describe('isPlannerManaged', () => {
  it('marks shopping and notes as Planner-managed', () => {
    expect(isPlannerManaged('shopping')).toBe(true)
    expect(isPlannerManaged('notes')).toBe(true)
  })

  it('keeps tasks and standard as own lists', () => {
    expect(isPlannerManaged('tasks')).toBe(false)
    expect(isPlannerManaged('standard')).toBe(false)
  })
})

describe('partitionByOrigin', () => {
  const list = (id: string, list_type: ListType) => ({ id, list_type })

  it('splits lists by origin, preserving order within each section', () => {
    const { own, plannerManaged } = partitionByOrigin([
      list('a', 'shopping'),
      list('b', 'tasks'),
      list('c', 'notes'),
      list('d', 'standard'),
    ])
    expect(own.map((l) => l.id)).toEqual(['b', 'd'])
    expect(plannerManaged.map((l) => l.id)).toEqual(['a', 'c'])
  })

  it('handles an empty input', () => {
    expect(partitionByOrigin([])).toEqual({ own: [], plannerManaged: [] })
  })

  it('marks EVERY list planner-managed when the scope is planner-origin (#531)', () => {
    const { own, plannerManaged } = partitionByOrigin(
      [list('a', 'tasks'), list('b', 'standard'), list('c', 'notes')],
      true,
    )
    expect(own).toEqual([])
    expect(plannerManaged.map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })

  it('scopeIsPlanner=false keeps the list-type partition', () => {
    const { own, plannerManaged } = partitionByOrigin(
      [list('a', 'tasks'), list('b', 'shopping')],
      false,
    )
    expect(own.map((l) => l.id)).toEqual(['a'])
    expect(plannerManaged.map((l) => l.id)).toEqual(['b'])
  })
})

describe('resolvePlannerReadOnly (#675)', () => {
  it('is writable for non-list_group scopes regardless of lookup result', () => {
    expect(resolvePlannerReadOnly('direct', 'x', null)).toBe(false)
    expect(resolvePlannerReadOnly('direct', 'x', { items: [] })).toBe(false)
  })

  it('is read-only when the matching group is planner-origin', () => {
    expect(
      resolvePlannerReadOnly('list_group', 'lgr_1', {
        items: [{ id: 'lgr_1', origin: 'planner' }],
      }),
    ).toBe(true)
  })

  it('is writable when the matching group is not planner-origin', () => {
    expect(
      resolvePlannerReadOnly('list_group', 'lgr_1', {
        items: [{ id: 'lgr_1', origin: null }],
      }),
    ).toBe(false)
  })

  it('fails CLOSED (read-only) when the groups lookup failed', () => {
    expect(resolvePlannerReadOnly('list_group', 'lgr_1', null)).toBe(true)
  })

  it('is writable when the group id is not found in a successful lookup', () => {
    expect(resolvePlannerReadOnly('list_group', 'lgr_missing', { items: [] })).toBe(false)
  })
})
