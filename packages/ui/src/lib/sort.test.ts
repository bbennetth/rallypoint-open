import { describe, expect, it } from 'vitest'
import { compareValues, nextSortState } from './sort.js'

describe('nextSortState', () => {
  it('returns ascending when no previous state', () => {
    expect(nextSortState(null, 'name')).toEqual({ column: 'name', dir: 'asc' })
  })

  it('returns ascending when a different column is clicked', () => {
    expect(nextSortState({ column: 'name', dir: 'desc' }, 'email')).toEqual({
      column: 'email',
      dir: 'asc',
    })
  })

  it('flips direction when the same column is clicked again', () => {
    expect(nextSortState({ column: 'name', dir: 'asc' }, 'name')).toEqual({
      column: 'name',
      dir: 'desc',
    })
    expect(nextSortState({ column: 'name', dir: 'desc' }, 'name')).toEqual({
      column: 'name',
      dir: 'asc',
    })
  })
})

describe('compareValues', () => {
  it('sorts strings asc and desc', () => {
    expect(compareValues('a', 'b', 'asc')).toBe(-1)
    expect(compareValues('a', 'b', 'desc')).toBe(1)
  })

  it('sorts numbers', () => {
    expect(compareValues(1, 2, 'asc')).toBe(-1)
    expect(compareValues(2, 1, 'desc')).toBe(-1)
  })

  it('sorts dates by epoch ms', () => {
    const a = new Date('2026-01-01T00:00:00Z')
    const b = new Date('2026-02-01T00:00:00Z')
    expect(compareValues(a, b, 'asc')).toBe(-1)
    expect(compareValues(b, a, 'asc')).toBe(1)
  })

  it('returns 0 for equal values', () => {
    expect(compareValues(5, 5, 'asc')).toBe(0)
    expect(compareValues('x', 'x', 'desc')).toBe(0)
  })

  it('sorts nulls to the end regardless of direction', () => {
    expect(compareValues(null, 'a', 'asc')).toBe(1)
    expect(compareValues('a', null, 'asc')).toBe(-1)
    expect(compareValues(null, 'a', 'desc')).toBe(1)
    expect(compareValues('a', null, 'desc')).toBe(-1)
    expect(compareValues(null, undefined, 'asc')).toBe(0)
  })
})
