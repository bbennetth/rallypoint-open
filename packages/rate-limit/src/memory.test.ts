import { describe, it, expect } from 'vitest'
import { InMemoryRateLimitRepo } from './memory.js'
import type { TakeTokenInput } from './algorithm.js'

// Fixed base time so the sliding window is deterministic. All requests
// land in the same window (well within windowSeconds), so the blended
// count equals the stored count.
const T0 = new Date('2026-01-01T00:00:00.000Z')

function input(overrides: Partial<TakeTokenInput> = {}): TakeTokenInput {
  return {
    tenantId: 'tenant',
    bucketKey: 'bucket',
    limit: 2,
    windowSeconds: 60,
    now: T0,
    ...overrides,
  }
}

describe('InMemoryRateLimitRepo', () => {
  it('allows up to the limit, then blocks', async () => {
    const repo = new InMemoryRateLimitRepo()
    expect((await repo.takeToken(input())).allowed).toBe(true)
    expect((await repo.takeToken(input())).allowed).toBe(true)
    expect((await repo.takeToken(input())).allowed).toBe(false)
  })

  it('keeps accumulating the stored count while blocked, like the D1 repo', async () => {
    // Regression: the double used to persist the increment only when the
    // request was allowed, so repeated over-limit requests all reported
    // the same blendedCount. The real D1 repo increments unconditionally,
    // so the count must keep climbing past the block point here too.
    const repo = new InMemoryRateLimitRepo()
    await repo.takeToken(input()) // count 1, allowed
    await repo.takeToken(input()) // count 2, allowed
    const first = await repo.takeToken(input()) // count 3, blocked
    const second = await repo.takeToken(input()) // count 4, blocked
    const third = await repo.takeToken(input()) // count 5, blocked

    expect(first.allowed).toBe(false)
    expect(second.allowed).toBe(false)
    expect(third.allowed).toBe(false)
    expect(second.blendedCount).toBeGreaterThan(first.blendedCount)
    expect(third.blendedCount).toBeGreaterThan(second.blendedCount)
  })

  it('reset clears the bucket so requests are allowed again', async () => {
    const repo = new InMemoryRateLimitRepo()
    await repo.takeToken(input())
    await repo.takeToken(input())
    expect((await repo.takeToken(input())).allowed).toBe(false)
    await repo.reset('tenant', 'bucket')
    expect((await repo.takeToken(input())).allowed).toBe(true)
  })
})
