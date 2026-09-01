import { describe, expect, it, vi } from 'vitest'
import { D1_WARM_CRON, isWarmTick, warmD1, warmD1AndLog } from './d1-warm.js'

describe('warmD1', () => {
  it('issues a real storage read via prepare().first()', async () => {
    const first = vi.fn(async () => null)
    const prepare = vi.fn(() => ({ first }))
    await warmD1({ prepare })
    expect(prepare).toHaveBeenCalledExactlyOnceWith('SELECT 1 FROM sqlite_master LIMIT 1')
    expect(first).toHaveBeenCalledOnce()
  })

  // Deterministic error so withD1Retry rethrows immediately instead of
  // burning retry backoff in the test.
  it('propagates rejections to the caller', async () => {
    const err = new Error('no such table: nope')
    const db = { prepare: () => ({ first: () => Promise.reject(err) }) }
    await expect(warmD1(db)).rejects.toBe(err)
  })

  it('retries a transient D1 failure before succeeding', async () => {
    const err = new Error('Network connection lost')
    const first = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(null)
    await warmD1({ prepare: () => ({ first }) })
    expect(first).toHaveBeenCalledTimes(2)
  })
})

describe('warmD1AndLog', () => {
  it('resolves without logging on success', async () => {
    const warn = vi.fn()
    await warmD1AndLog({ prepare: () => ({ first: async () => null }) }, { warn })
    expect(warn).not.toHaveBeenCalled()
  })

  it('swallows a rejection and logs one warn line', async () => {
    const err = new Error('no such table: nope')
    const warn = vi.fn()
    await expect(
      warmD1AndLog({ prepare: () => ({ first: () => Promise.reject(err) }) }, { warn }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledExactlyOnceWith({ err }, 'D1 keep-warm ping failed')
  })
})

describe('isWarmTick', () => {
  it('is true only for the warm cron expression', () => {
    expect(isWarmTick(D1_WARM_CRON)).toBe(true)
    expect(isWarmTick('5 * * * *')).toBe(false)
    expect(isWarmTick('0 4 * * *')).toBe(false)
  })

  it('treats a missing cron (local --test-scheduled) as a domain tick', () => {
    expect(isWarmTick(undefined)).toBe(false)
  })
})
