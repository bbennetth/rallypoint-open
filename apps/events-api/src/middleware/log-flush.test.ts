import { describe, expect, it, vi } from 'vitest'
import { logFlush } from './log-flush.js'

// The logFlush middleware is identical across all seven Worker APIs; this
// exercises the shared shape (schedule the flush after next(), even on a
// throw, and fall back to a bare flush when there is no execution context).

// Minimal duck-typed Hono context — only executionCtx.waitUntil is read.
function fakeCtx(waitUntil?: (p: Promise<unknown>) => void) {
  return {
    ...(waitUntil ? { executionCtx: { waitUntil } } : {}),
  } as never
}

describe('logFlush', () => {
  it('schedules the flush via executionCtx.waitUntil after a successful request', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const waitUntil = vi.fn()
    const mw = logFlush(flush)
    await mw(fakeCtx(waitUntil), async () => {})
    expect(waitUntil).toHaveBeenCalledTimes(1)
    // The promise handed to waitUntil is the flush() call.
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('still schedules the flush when the downstream handler throws', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const waitUntil = vi.fn()
    const mw = logFlush(flush)
    await expect(
      mw(fakeCtx(waitUntil), async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    // finally ran despite the throw.
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('falls back to a bare flush when there is no execution context', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const mw = logFlush(flush)
    // No executionCtx on the context → the waitUntil access throws and the
    // catch fires flush() directly.
    await mw(fakeCtx(undefined), async () => {})
    expect(flush).toHaveBeenCalledTimes(1)
  })
})
