import { describe, it, expect } from 'vitest'
import { canDeletePersonalList } from './list-delete.js'

describe('canDeletePersonalList', () => {
  it('returns true for a tasks list', () => {
    expect(canDeletePersonalList({ listType: 'tasks' })).toBe(true)
  })

  it('returns true for a standard list', () => {
    expect(canDeletePersonalList({ listType: 'standard' })).toBe(true)
  })

  it('returns false for the notes list', () => {
    expect(canDeletePersonalList({ listType: 'notes' })).toBe(false)
  })

  it('returns false for the shopping list', () => {
    expect(canDeletePersonalList({ listType: 'shopping' })).toBe(false)
  })
})
