import { describe, it, expect } from 'vitest'
import { isPlannerManaged, partitionByOrigin } from './list-origin.js'
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
