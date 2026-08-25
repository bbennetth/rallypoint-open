import { describe, it, expect } from 'vitest'
import { isStaleGeneration } from './loadGeneration.js'

describe('isStaleGeneration', () => {
  it('is not stale when the captured generation matches current', () => {
    expect(isStaleGeneration(1, 1)).toBe(false)
  })

  it('is stale when a newer generation has since started', () => {
    // The classic StrictMode double-invoke case: load() #1 captures gen 1,
    // load() #2 (or a create()) bumps to gen 2 before #1 resolves.
    expect(isStaleGeneration(1, 2)).toBe(true)
  })

  it('is stale when the captured generation is somehow ahead (defensive)', () => {
    expect(isStaleGeneration(3, 2)).toBe(true)
  })
})
