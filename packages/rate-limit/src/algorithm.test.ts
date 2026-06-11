import { describe, it, expect } from 'vitest'
import { computeBlend, windowStartMs } from './algorithm.js'

describe('computeBlend', () => {
  it('returns currentCount when previousCount is zero', () => {
    expect(
      computeBlend({ currentCount: 3, previousCount: 0, positionMs: 0, windowMs: 60_000 }),
    ).toBe(3)
  })

  it('weights the previous window by (1 - position/window)', () => {
    // Halfway through the window: previous counts at 50%.
    expect(
      computeBlend({ currentCount: 0, previousCount: 10, positionMs: 30_000, windowMs: 60_000 }),
    ).toBe(5)
  })

  it('returns currentCount when position equals window length', () => {
    expect(
      computeBlend({ currentCount: 0, previousCount: 10, positionMs: 60_000, windowMs: 60_000 }),
    ).toBe(0)
  })

  it('floors the blended count', () => {
    expect(
      computeBlend({ currentCount: 1, previousCount: 1, positionMs: 30_000, windowMs: 60_000 }),
    ).toBe(1) // floor(1 + 0.5)
  })

  it('returns currentCount on degenerate windowMs', () => {
    expect(
      computeBlend({ currentCount: 9, previousCount: 99, positionMs: 0, windowMs: 0 }),
    ).toBe(9)
  })

  it('returns exactly limit at the boundary (blended === limit is allowed)', () => {
    // currentCount = 5, previousCount = 0, position = 0 → blended = 5
    expect(
      computeBlend({ currentCount: 5, previousCount: 0, positionMs: 0, windowMs: 60_000 }),
    ).toBe(5)
  })

  it('previous weight is clamped to zero when positionMs > windowMs', () => {
    // positionMs > windowMs: weight = max(0, 1 - 2) = 0 → only currentCount
    expect(
      computeBlend({ currentCount: 3, previousCount: 100, positionMs: 120_000, windowMs: 60_000 }),
    ).toBe(3)
  })

  it('blends correctly at the very start of a new window (positionMs === 0)', () => {
    // At the very start previous weight = 1.0 → blended = current + previous
    expect(
      computeBlend({ currentCount: 2, previousCount: 8, positionMs: 0, windowMs: 60_000 }),
    ).toBe(10)
  })
})

describe('windowStartMs', () => {
  it('quantizes nowMs to the start of the window', () => {
    expect(windowStartMs(60_000, 60_000)).toBe(60_000)
    expect(windowStartMs(60_001, 60_000)).toBe(60_000)
    expect(windowStartMs(119_999, 60_000)).toBe(60_000)
    expect(windowStartMs(120_000, 60_000)).toBe(120_000)
  })

  it('handles sub-minute windows', () => {
    expect(windowStartMs(5_500, 1_000)).toBe(5_000)
    expect(windowStartMs(5_999, 1_000)).toBe(5_000)
    expect(windowStartMs(6_000, 1_000)).toBe(6_000)
  })

  it('returns 0 for nowMs=0', () => {
    expect(windowStartMs(0, 60_000)).toBe(0)
  })
})
