import { describe, it, expect, vi, afterEach } from 'vitest'
import { withTimeout, RpcTimeoutError, DEFAULT_RPC_TIMEOUT_MS } from './with-timeout.js'

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects with RpcTimeoutError once a hung promise outruns the bound', async () => {
    vi.useFakeTimers()
    // A promise that never settles — the id-api-hangs case.
    const hung = new Promise<string>(() => {})
    const raced = withTimeout(hung, 5_000, 'idClient.verifyRpidBearer')
    // Attach a catch synchronously so the eventual rejection isn't "unhandled".
    const settled = raced.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    )
    await vi.advanceTimersByTimeAsync(5_000)
    const outcome = await settled
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.err).toBeInstanceOf(RpcTimeoutError)
      expect((outcome.err as Error).message).toContain('idClient.verifyRpidBearer')
      expect((outcome.err as Error).message).toContain('5000ms')
    }
  })

  it('passes a fast resolution through and clears the timer', async () => {
    vi.useFakeTimers()
    const value = await withTimeout(Promise.resolve(42), 5_000, 'fast')
    expect(value).toBe(42)
    // A settled race must not leave a pending timer holding the isolate awake.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes a fast rejection through unchanged (not wrapped as a timeout)', async () => {
    vi.useFakeTimers()
    const original = new Error('transport boom')
    await expect(withTimeout(Promise.reject(original), 5_000, 'fast')).rejects.toBe(original)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('exposes a sane default bound', () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(5_000)
  })
})
