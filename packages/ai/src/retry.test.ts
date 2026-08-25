import { describe, expect, it, vi } from 'vitest'
import { aiErrorCode, DEFAULT_AI_RETRY, isCapacityError, withCapacityRetry } from './retry.js'

// The shape Workers AI throws for provider capacity pressure. The exact
// binding varies, so the detector probes several fields + the message.
const capacityMessage = '3040: Capacity temporarily exceeded, please try again'

describe('isCapacityError', () => {
  it('matches the 3040 / 429 capacity class across shapes', () => {
    expect(isCapacityError(new Error(capacityMessage))).toBe(true)
    expect(isCapacityError(Object.assign(new Error('boom'), { name: 'AiError', code: 3040 }))).toBe(true)
    expect(isCapacityError({ httpCode: 429, message: 'Too Many Requests' })).toBe(true)
    expect(isCapacityError({ status: '429' })).toBe(true)
    expect(isCapacityError(new Error('Capacity temporarily exceeded'))).toBe(true)
  })

  it('does NOT match deterministic parse failures', () => {
    expect(isCapacityError(new Error('Food vision model returned no JSON object.'))).toBe(false)
    expect(isCapacityError(new Error('output failed schema validation.'))).toBe(false)
    expect(isCapacityError({ code: 400, message: 'Bad Request' })).toBe(false)
    expect(isCapacityError(null)).toBe(false)
    expect(isCapacityError('nope')).toBe(false)
  })
})

describe('aiErrorCode', () => {
  it('extracts a numeric code from fields or a message prefix', () => {
    expect(aiErrorCode({ code: 3040 })).toBe('3040')
    expect(aiErrorCode({ httpCode: 429 })).toBe('429')
    expect(aiErrorCode(new Error(capacityMessage))).toBe('3040')
    expect(aiErrorCode(new Error('plain failure'))).toBeUndefined()
    expect(aiErrorCode(null)).toBeUndefined()
  })
})

describe('withCapacityRetry', () => {
  const hooks = { sleep: vi.fn(async () => {}), random: () => 0.5 }

  it('retries a capacity error then succeeds within budget', async () => {
    const sleep = vi.fn(async () => {})
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error(capacityMessage))
      .mockResolvedValueOnce('ok')
    const out = await withCapacityRetry(fn, { sleep, random: () => 0.5 })
    expect(out).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('does not retry a non-capacity error', async () => {
    const sleep = vi.fn(async () => {})
    const boom = new Error('returned no JSON object')
    const fn = vi.fn().mockRejectedValue(boom)
    await expect(withCapacityRetry(fn, { sleep })).rejects.toBe(boom)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('exhausts the budget then rethrows the final capacity error', async () => {
    const sleep = vi.fn(async () => {})
    const err = new Error(capacityMessage)
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withCapacityRetry(fn, { sleep, random: () => 0.5 })).rejects.toBe(err)
    // Initial attempt + maxRetries retries.
    expect(fn).toHaveBeenCalledTimes(DEFAULT_AI_RETRY.maxRetries + 1)
    expect(sleep).toHaveBeenCalledTimes(DEFAULT_AI_RETRY.maxRetries)
  })

  it('honours a custom budget and reports each retry', async () => {
    const sleep = vi.fn(async () => {})
    const onRetry = vi.fn()
    const err = new Error(capacityMessage)
    const fn = vi.fn().mockRejectedValue(err)
    await expect(
      withCapacityRetry(fn, {
        config: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 20 },
        sleep,
        random: () => 0,
        onRetry,
      }),
    ).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 5 }))
  })

  it('passes a first-try success straight through', async () => {
    const fn = vi.fn().mockResolvedValue(42)
    expect(await withCapacityRetry(fn, hooks)).toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(hooks.sleep).not.toHaveBeenCalled()
  })
})
