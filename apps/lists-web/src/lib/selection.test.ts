import { describe, it, expect } from 'vitest'
import { selectionRange } from './selection.js'

const ORDER = ['a', 'b', 'c', 'd', 'e']

describe('selectionRange', () => {
  it('returns the inclusive range when the anchor is above the target', () => {
    expect(selectionRange(ORDER, 'b', 'd')).toEqual(['b', 'c', 'd'])
  })

  it('returns the inclusive range when the anchor is below the target', () => {
    expect(selectionRange(ORDER, 'd', 'b')).toEqual(['b', 'c', 'd'])
  })

  it('returns a single id when anchor equals target', () => {
    expect(selectionRange(ORDER, 'c', 'c')).toEqual(['c'])
  })

  it('falls back to just the target when the anchor is no longer visible', () => {
    expect(selectionRange(ORDER, 'gone', 'c')).toEqual(['c'])
  })

  it('returns empty when the target itself is gone', () => {
    expect(selectionRange(ORDER, 'b', 'gone')).toEqual([])
  })
})
