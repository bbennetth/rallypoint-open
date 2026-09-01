import { describe, it, expect } from 'vitest'
import { isCacheableImage, isDuplicateRestPush, restPushShowOptions } from './swRoutes.js'

describe('isCacheableImage', () => {
  it('caches same-origin static images', () => {
    expect(isCacheableImage('image', '/icons/icon-192.png')).toBe(true)
  })

  it('never caches API responses or non-image destinations', () => {
    expect(isCacheableImage('image', '/api/v1/ui/progress-photos/x.jpg')).toBe(false)
    expect(isCacheableImage('document', '/logo.png')).toBe(false)
  })
})

describe('isDuplicateRestPush', () => {
  const DEADLINE = 1_756_000_000_000

  it('not a duplicate when no same-tag notification is visible', () => {
    expect(isDuplicateRestPush(DEADLINE, [])).toBe(false)
  })

  it("a duplicate only when this rest period's local banner (same deadline) is up", () => {
    expect(isDuplicateRestPush(DEADLINE, [DEADLINE])).toBe(true)
    expect(isDuplicateRestPush(DEADLINE, [DEADLINE - 90_000, DEADLINE])).toBe(true)
  })

  it("an EARLIER rest's stale banner (per-session tag) is not a duplicate", () => {
    expect(isDuplicateRestPush(DEADLINE, [DEADLINE - 90_000])).toBe(false)
  })

  it('fails open when the payload has no deadline (old server build)', () => {
    expect(isDuplicateRestPush(undefined, [DEADLINE])).toBe(false)
  })

  it('fails open when the visible banner carries no data (old client banner)', () => {
    expect(isDuplicateRestPush(DEADLINE, [undefined])).toBe(false)
  })
})

describe('restPushShowOptions', () => {
  const DEADLINE = 1_756_000_000_000

  it('a duplicate still shows — silently, keeping the deadline as data', () => {
    expect(restPushShowOptions(DEADLINE, [DEADLINE])).toEqual({
      silent: true,
      data: { deadlineMs: DEADLINE },
    })
  })

  it('a fresh backstop alerts normally', () => {
    expect(restPushShowOptions(DEADLINE, [DEADLINE - 90_000])).toEqual({
      silent: null,
      data: { deadlineMs: DEADLINE },
    })
  })

  it('a payload without a deadline alerts normally and stamps no data', () => {
    expect(restPushShowOptions(undefined, [DEADLINE])).toEqual({
      silent: null,
      data: undefined,
    })
  })
})
