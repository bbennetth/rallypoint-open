import { describe, expect, it } from 'vitest'
import { shouldRefetchOnVisible, VISIBLE_REFETCH_MIN_MS } from './use-cached-query.js'

describe('shouldRefetchOnVisible', () => {
  it('allows when no fetch has settled yet', () => {
    expect(shouldRefetchOnVisible(undefined, 1_000)).toBe(true)
  })

  it('skips when a fetch settled inside the throttle window', () => {
    expect(shouldRefetchOnVisible(10_000, 10_000 + VISIBLE_REFETCH_MIN_MS - 1)).toBe(false)
  })

  it('allows at and past the throttle boundary', () => {
    expect(shouldRefetchOnVisible(10_000, 10_000 + VISIBLE_REFETCH_MIN_MS)).toBe(true)
    expect(shouldRefetchOnVisible(10_000, 10_000 + VISIBLE_REFETCH_MIN_MS * 3)).toBe(true)
  })
})
