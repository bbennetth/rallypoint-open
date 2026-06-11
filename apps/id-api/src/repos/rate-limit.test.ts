import { describe, it, expect } from 'vitest'
import { computeBlend, windowStartMs } from '@rallypoint/rate-limit'

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
})

describe('windowStartMs', () => {
  it('quantizes nowMs to the start of the window', () => {
    expect(windowStartMs(60_000, 60_000)).toBe(60_000)
    expect(windowStartMs(60_001, 60_000)).toBe(60_000)
    expect(windowStartMs(119_999, 60_000)).toBe(60_000)
    expect(windowStartMs(120_000, 60_000)).toBe(120_000)
  })
})
