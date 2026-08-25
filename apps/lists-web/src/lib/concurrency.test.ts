import { describe, it, expect, vi } from 'vitest'
import { runWithConcurrency } from './concurrency.js'

describe('runWithConcurrency', () => {
  it('runs every item and preserves result order', async () => {
    const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2)
    expect(results).toEqual([2, 4, 6, 8, 10])
  })

  it('never has more than `limit` calls in flight at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      4,
      async (n) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight--
        return n
      },
    )
    expect(maxInFlight).toBeLessThanOrEqual(4)
  })

  it('propagates a rejection like Promise.all', async () => {
    const fn = vi.fn(async (n: number) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    await expect(runWithConcurrency([1, 2, 3], 2, fn)).rejects.toThrow('boom')
  })

  it('drains in-flight tasks before rejecting (no late writes after the caller reconciles)', async () => {
    // One task fails fast while its siblings are still in flight. The
    // returned promise must not reject until those siblings settle —
    // otherwise the caller's reconcile (load()) races the late writes.
    const completed: number[] = []
    const p = runWithConcurrency([0, 1, 2], 3, async (n) => {
      if (n === 0) {
        await Promise.resolve() // yield so 1 and 2 start
        throw new Error('boom')
      }
      await new Promise((r) => setTimeout(r, 10))
      completed.push(n)
      return n
    })
    await expect(p).rejects.toThrow('boom')
    // By the time the rejection surfaces, both slow siblings have finished.
    expect(completed.sort()).toEqual([1, 2])
  })

  it('abandons the remaining tail after a failure', async () => {
    // With 2 workers and a failure on the 2nd item, the fan-out is
    // abandoned — the tail items are never dispatched (exact cutoff is
    // microtask-timing dependent, so assert the robust invariant: not all
    // items run, and the last one never does).
    const started: number[] = []
    const fn = vi.fn(async (n: number) => {
      started.push(n)
      if (n === 1) throw new Error('boom')
      return n
    })
    await expect(runWithConcurrency([0, 1, 2, 3, 4], 2, fn)).rejects.toThrow('boom')
    expect(started.length).toBeLessThan(5)
    expect(started).not.toContain(4)
    expect(started).toContain(0)
    expect(started).toContain(1)
  })

  it('handles an empty input', async () => {
    const results = await runWithConcurrency([], 4, async (n: number) => n)
    expect(results).toEqual([])
  })
})
