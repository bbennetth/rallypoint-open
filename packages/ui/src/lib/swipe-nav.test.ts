import { describe, it, expect } from 'vitest'
import { swipeDirection, nextTabIndex } from './swipe-nav.js'

describe('swipeDirection', () => {
  it('returns 0 when dx is too short', () => {
    expect(swipeDirection(40, 0, 200)).toBe(0)
  })

  it('returns 0 when gesture is too slow', () => {
    expect(swipeDirection(100, 0, 700)).toBe(0)
  })

  it('returns 0 when gesture is too vertical (|dy| dominates)', () => {
    // dx=60, dy=50: |dx| / |dy| = 1.2 < 1.4 → vertical
    expect(swipeDirection(60, 50, 300)).toBe(0)
  })

  it('returns 1 for a clear left swipe (dx < 0, next tab)', () => {
    expect(swipeDirection(-100, 10, 300)).toBe(1)
  })

  it('returns -1 for a clear right swipe (dx > 0, prev tab)', () => {
    expect(swipeDirection(100, 10, 300)).toBe(-1)
  })

  it('returns 0 at exactly the minimum distance threshold (exclusive)', () => {
    expect(swipeDirection(59, 0, 300)).toBe(0)
  })

  it('returns -1 at exactly the minimum distance threshold (inclusive)', () => {
    expect(swipeDirection(60, 0, 300)).toBe(-1)
  })
})

describe('nextTabIndex', () => {
  it('returns current unchanged when dir is 0', () => {
    expect(nextTabIndex(2, 5, 0)).toBe(2)
  })

  it('returns current unchanged when current is -1', () => {
    expect(nextTabIndex(-1, 5, 1)).toBe(-1)
  })

  it('advances forward', () => {
    expect(nextTabIndex(1, 5, 1)).toBe(2)
  })

  it('advances backward', () => {
    expect(nextTabIndex(2, 5, -1)).toBe(1)
  })

  it('clamps at the last index (no wrap)', () => {
    expect(nextTabIndex(4, 5, 1)).toBe(4)
  })

  it('clamps at index 0 (no wrap)', () => {
    expect(nextTabIndex(0, 5, -1)).toBe(0)
  })
})
