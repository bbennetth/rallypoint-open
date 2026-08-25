import { afterEach, describe, expect, it, vi } from 'vitest'
import { withCrossTabLock } from './flusher.js'

// A minimal in-memory stand-in for the Web Locks API: exclusive requests
// on the same key run one at a time, FIFO — mirroring how navigator.locks
// serializes holders. Enough to prove the drain can't interleave cross-tab.
function makeLockManager() {
  const chains = new Map<string, Promise<unknown>>()
  return {
    request(
      key: string,
      _opts: { mode: string },
      fn: () => Promise<unknown>,
    ): Promise<unknown> {
      const prev = chains.get(key) ?? Promise.resolve()
      // Chain this request behind any in-flight holder of the same key.
      const run = prev.then(() => fn())
      // Keep the chain alive but swallow rejections so one failing holder
      // doesn't poison the queue for the next waiter.
      chains.set(
        key,
        run.then(
          () => undefined,
          () => undefined,
        ),
      )
      return run
    },
  }
}

const nextTick = () => new Promise((r) => setTimeout(r, 0))

describe('withCrossTabLock', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs fn directly when navigator.locks is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    const fn = vi.fn(async () => {})
    await withCrossTabLock('k', fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('requests an exclusive lock for the key and runs fn inside it', async () => {
    const request = vi.fn(
      (_key: string, _opts: { mode: string }, fn: () => Promise<unknown>) => fn(),
    )
    vi.stubGlobal('navigator', { locks: { request } })

    const fn = vi.fn(async () => {})
    await withCrossTabLock('offline-outbox:db', fn)

    expect(request).toHaveBeenCalledWith(
      'offline-outbox:db',
      { mode: 'exclusive' },
      expect.any(Function),
    )
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent holders of the same key (no duplicate drain)', async () => {
    vi.stubGlobal('navigator', { locks: makeLockManager() })

    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r
    })

    const first = withCrossTabLock('same', async () => {
      order.push('first:start')
      await firstGate
      order.push('first:end')
    })
    const second = withCrossTabLock('same', async () => {
      order.push('second:start')
    })

    // Let both requests reach the lock. Only the first may run its body;
    // the second must wait — this is the regression the lock prevents.
    await nextTick()
    expect(order).toEqual(['first:start'])

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })
})
