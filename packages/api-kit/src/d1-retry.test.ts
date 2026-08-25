import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isTransientD1Error,
  withD1Retry,
  D1_RETRY_ATTEMPTS,
  D1_RETRY_BASE_DELAY_MS,
} from './d1-retry.js'

// drizzle's d1 driver wraps runtime errors: outer message "Failed query: …",
// real D1 text on `.cause`. Build that shape the way production sees it.
function drizzleWrapped(causeMessage: string): Error {
  return new Error('Failed query: select "id_hash" from "sessions" where "id_hash" = ? limit ?', {
    cause: new Error(causeMessage),
  })
}

describe('isTransientD1Error', () => {
  it.each([
    'Network connection lost.',
    'D1_ERROR: storage caused object to be reset',
    // Exact production shape (PostHog 2026-08-24): the write-storm timeout.
    'D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.',
    'The Durable Object was reset because its code was updated',
    'D1 DB is overloaded',
    'Cannot complete request due to a transient issue',
    'database is locked',
    'D1_ERROR: SQLITE_BUSY',
  ])('matches known-transient D1 text on the cause chain: %s', (text) => {
    expect(isTransientD1Error(drizzleWrapped(text))).toBe(true)
  })

  it('matches transient text on the top-level error too', () => {
    expect(isTransientD1Error(new Error('Network connection lost.'))).toBe(true)
  })

  it('walks a multi-level cause chain', () => {
    const nested = new Error('Failed query: update "sessions" …', {
      cause: new Error('D1_ERROR', { cause: new Error('storage caused object to be reset') }),
    })
    expect(isTransientD1Error(nested)).toBe(true)
  })

  it.each([
    'D1_ERROR: too many SQL variables at offset 1110: SQLITE_ERROR',
    'UNIQUE constraint failed: sessions.id_hash',
    'near "SELEC": syntax error',
  ])('rejects deterministic SQL errors — these must NOT retry: %s', (text) => {
    expect(isTransientD1Error(drizzleWrapped(text))).toBe(false)
  })

  it('handles non-Error throwables and a self-referencing cause without spinning', () => {
    expect(isTransientD1Error('Network connection lost.')).toBe(true)
    expect(isTransientD1Error(undefined)).toBe(false)
    expect(isTransientD1Error({ message: 'overloaded' })).toBe(false)
    const cyclic = new Error('Failed query: …')
    cyclic.cause = cyclic
    expect(isTransientD1Error(cyclic)).toBe(false)
  })
})

describe('withD1Retry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes a first-try success through with a single call', async () => {
    const fn = vi.fn().mockResolvedValue(42)
    await expect(withD1Retry(fn)).resolves.toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('rethrows a deterministic error immediately without retrying', async () => {
    const deterministic = drizzleWrapped('too many SQL variables at offset 1110: SQLITE_ERROR')
    const fn = vi.fn().mockRejectedValue(deterministic)
    await expect(withD1Retry(fn)).rejects.toBe(deterministic)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a transient failure and returns the eventual success', async () => {
    vi.useFakeTimers()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(drizzleWrapped('Network connection lost.'))
      .mockResolvedValueOnce('row')
    const pending = withD1Retry(fn)
    await vi.advanceTimersByTimeAsync(D1_RETRY_BASE_DELAY_MS)
    await expect(pending).resolves.toBe('row')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('gives up after the attempts budget and rethrows the transient error', async () => {
    vi.useFakeTimers()
    const transient = drizzleWrapped('D1 DB is overloaded')
    const fn = vi.fn().mockRejectedValue(transient)
    const pending = withD1Retry(fn)
    // Attach the rejection handler before advancing so it isn't "unhandled".
    const settled = pending.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    )
    // Backoff is base * 3^(n-1): 50ms then 150ms for the default 3 attempts.
    await vi.advanceTimersByTimeAsync(D1_RETRY_BASE_DELAY_MS * 4)
    const outcome = await settled
    expect(outcome).toEqual({ ok: false, err: transient })
    expect(fn).toHaveBeenCalledTimes(D1_RETRY_ATTEMPTS)
  })

  it('clamps a zero attempts budget to one attempt (throws the error, not undefined)', async () => {
    const transient = drizzleWrapped('Network connection lost.')
    const fn = vi.fn().mockRejectedValue(transient)
    await expect(withD1Retry(fn, { attempts: 0 })).rejects.toBe(transient)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('honors a caller-supplied attempts budget', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValue(drizzleWrapped('Network connection lost.'))
    const settled = withD1Retry(fn, { attempts: 1 }).then(
      () => true,
      () => false,
    )
    await vi.advanceTimersByTimeAsync(0)
    await expect(settled).resolves.toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
