import { describe, expect, it, vi } from 'vitest'
import { scheduleFlush } from './logger.js'

// ai-api has no logFlush middleware (its surface is RPC + cron + a health
// route), so every drain goes through `scheduleFlush` from inside a
// `finally`. A throw there would replace the method's real return value or
// mask its error, which is why the waitUntil call is guarded — same
// contract as the other apps' logFlush middleware.
describe('scheduleFlush', () => {
  it('hands the flush promise to waitUntil so the send outlives the response', () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const waitUntil = vi.fn()

    scheduleFlush({ waitUntil }, flush)

    expect(flush).toHaveBeenCalledTimes(1)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(waitUntil.mock.calls[0]![0]).toBeInstanceOf(Promise)
  })

  // Regression guard: `ctx?.waitUntil(flush())` short-circuits the WHOLE
  // expression when ctx is nullish, so flush would never run at all and
  // the batch would be dropped rather than merely not lifetime-extended.
  it('starts the flush even when ctx is nullish (no short-circuit)', () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    scheduleFlush(undefined, flush)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('swallows a throwing waitUntil, having already started the flush', () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const waitUntil = vi.fn(() => {
      throw new Error('no execution context')
    })

    expect(() => scheduleFlush({ waitUntil }, flush)).not.toThrow()
    // Started once, up front — not retried on the waitUntil failure.
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('hands waitUntil a promise that never rejects, even if the flush does', async () => {
    const flush = vi.fn().mockRejectedValue(new Error('network down'))
    const waitUntil = vi.fn()

    expect(() => scheduleFlush({ waitUntil }, flush)).not.toThrow()
    // A rejecting promise inside waitUntil would surface as an unhandled
    // rejection in the isolate; the helper absorbs it first.
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
  })
})
