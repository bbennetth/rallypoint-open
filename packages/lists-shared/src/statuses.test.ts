import { describe, it, expect } from 'vitest'
import {
  DEFAULT_STATUS_SEEDS,
  isDoneCategory,
  categoryMirrorsCompleted,
  defaultStatusForCategory,
  firstDoneStatus,
  isLastDoneStatus,
  type StatusLike,
} from './statuses.js'

describe('DEFAULT_STATUS_SEEDS', () => {
  it('reproduces the legacy todo → in_progress → done board, in order', () => {
    expect(DEFAULT_STATUS_SEEDS.map((s) => s.category)).toEqual([
      'todo',
      'in_progress',
      'done',
    ])
  })

  it('has exactly one done-category seed', () => {
    expect(DEFAULT_STATUS_SEEDS.filter((s) => s.category === 'done')).toHaveLength(1)
  })
})

describe('isDoneCategory / categoryMirrorsCompleted', () => {
  it('treats only done as complete', () => {
    expect(isDoneCategory('done')).toBe(true)
    expect(isDoneCategory('todo')).toBe(false)
    expect(isDoneCategory('in_progress')).toBe(false)
    expect(categoryMirrorsCompleted('done')).toEqual({ completed: true })
    expect(categoryMirrorsCompleted('todo')).toEqual({ completed: false })
  })
})

const mk = (id: string, category: StatusLike['category'], position: number): StatusLike => ({
  id,
  category,
  position,
})

describe('defaultStatusForCategory', () => {
  const statuses = [
    mk('a', 'todo', 0),
    mk('b', 'in_progress', 1),
    mk('c', 'done', 2),
    mk('d', 'done', 3),
    mk('z', 'todo', 5),
  ]

  it('returns the lowest-position match for the category', () => {
    expect(defaultStatusForCategory(statuses, 'todo')?.id).toBe('a')
    expect(defaultStatusForCategory(statuses, 'done')?.id).toBe('c')
  })

  it('is order-independent (picks by position, not array index)', () => {
    const shuffled = [mk('d', 'done', 3), mk('c', 'done', 2)]
    expect(defaultStatusForCategory(shuffled, 'done')?.id).toBe('c')
  })

  it('returns null when no status has the category', () => {
    expect(defaultStatusForCategory([mk('a', 'todo', 0)], 'done')).toBeNull()
  })
})

describe('firstDoneStatus', () => {
  it('returns the first done-category status', () => {
    expect(firstDoneStatus([mk('a', 'todo', 0), mk('c', 'done', 2)])?.id).toBe('c')
  })
  it('returns null when there is no done status', () => {
    expect(firstDoneStatus([mk('a', 'todo', 0)])).toBeNull()
  })
})

describe('isLastDoneStatus', () => {
  it('is true for the sole done status', () => {
    const s = [mk('a', 'todo', 0), mk('c', 'done', 2)]
    expect(isLastDoneStatus(s, 'c')).toBe(true)
  })
  it('is false when another done status remains', () => {
    const s = [mk('c', 'done', 2), mk('d', 'done', 3)]
    expect(isLastDoneStatus(s, 'c')).toBe(false)
  })
  it('is false for a non-done status', () => {
    const s = [mk('a', 'todo', 0), mk('c', 'done', 2)]
    expect(isLastDoneStatus(s, 'a')).toBe(false)
  })
  it('is false for an unknown id', () => {
    const s = [mk('c', 'done', 2)]
    expect(isLastDoneStatus(s, 'nope')).toBe(false)
  })
})
