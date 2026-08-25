// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { triggerCachedQueryRefetch, VISIBLE_REFETCH_MIN_MS } from '@rallypoint/offline-kit'
import { renderHook, waitFor, act } from '@testing-library/react'
import Dexie from 'dexie'
import { cachedFetch, mutateCachedArray, setOfflineUser } from './cache.js'
import { _resetCacheSubscribers } from './cache-subscribers.js'
import { useCachedQuery, type CachedQuery } from './use-cached-query.js'

// Render-from-cache hook: cached data paints immediately (status
// 'stale'), the parallel fetch upgrades to 'fresh', cache writes from
// anywhere re-render via the subscription, and only a true cold miss
// shows 'loading'.

let UID = 'baseline'

beforeEach(() => {
  UID = `user_hook_${Math.floor(Math.random() * 1e9)}`
  setOfflineUser(UID)
})

afterEach(async () => {
  setOfflineUser(null)
  _resetCacheSubscribers()
  try {
    await Dexie.delete(`planner-offline:${UID}`)
  } catch {
    // ignore
  }
})

// A descriptor whose fetch goes through the real cachedFetch (so a
// success writes the cache + notifies), backed by a controllable stub.
function makeQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
): CachedQuery<T> {
  return { table: 'taskItems', key, fetch: () => cachedFetch('taskItems', key, fetcher) }
}

describe('useCachedQuery', () => {
  it('cold miss: loading until the fetch resolves, then fresh', async () => {
    const q = makeQuery('cold', async () => [{ id: 'a' }])
    const { result } = renderHook(() => useCachedQuery(q))
    expect(result.current.status).toBe('loading')
    expect(result.current.data).toBeUndefined()

    await waitFor(() => expect(result.current.status).toBe('fresh'))
    expect(result.current.data).toEqual([{ id: 'a' }])
  })

  it('warm cache: renders cached data before the slow fetch lands, then upgrades', async () => {
    // Seed the cache.
    await cachedFetch('taskItems', 'warm', async () => [{ id: 'cached' }])

    let release: (v: { id: string }[]) => void = () => {}
    const slow = new Promise<{ id: string }[]>((r) => {
      release = r
    })
    const q = makeQuery('warm', () => slow)
    const { result } = renderHook(() => useCachedQuery(q))

    // Cached value paints without waiting for the network.
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'cached' }]))
    expect(result.current.status).toBe('stale')

    await act(async () => {
      release([{ id: 'fresh' }])
      await slow
    })
    await waitFor(() => expect(result.current.status).toBe('fresh'))
    expect(result.current.data).toEqual([{ id: 'fresh' }])
  })

  it('fetch failure with cached data keeps the data (no error state)', async () => {
    await cachedFetch('taskItems', 'held', async () => [{ id: 'kept' }])
    const q = makeQuery('held', () => Promise.reject(new Error('down')))
    const { result } = renderHook(() => useCachedQuery(q))

    // cachedFetch falls back to the cache on transport failure, so the
    // fetch RESOLVES with cached data → the page keeps rendering it.
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'kept' }]))
    expect(result.current.status).not.toBe('error')
  })

  it('fetch failure with no cached data → error', async () => {
    const q = makeQuery('dead', () => Promise.reject(new Error('down')))
    const { result } = renderHook(() => useCachedQuery(q))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBeInstanceOf(Error)
  })

  it('re-renders when another writer mutates the cached channel', async () => {
    const q = makeQuery('shared', async () => [{ id: 'a', completed: false }])
    const { result } = renderHook(() => useCachedQuery(q))
    await waitFor(() => expect(result.current.status).toBe('fresh'))

    // An optimistic mutation elsewhere (api.ts write path).
    await act(async () => {
      await mutateCachedArray<{ id: string; completed: boolean }>(
        'taskItems',
        'shared',
        (items) => items.map((i) => ({ ...i, completed: true })),
      )
    })
    await waitFor(() =>
      expect(result.current.data).toEqual([{ id: 'a', completed: true }]),
    )
  })

  it('key change drops the previous rows and refetches', async () => {
    const fetches: Record<string, number> = {}
    const fetcherFor = (key: string) => async () => {
      fetches[key] = (fetches[key] ?? 0) + 1
      return [{ id: key }]
    }
    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => useCachedQuery(makeQuery(k, fetcherFor(k))),
      { initialProps: { k: 'one' } },
    )
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'one' }]))

    rerender({ k: 'two' })
    // Old rows never bleed into the new key.
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'two' }]))
    expect(fetches).toEqual({ one: 1, two: 1 })
  })

  it('null query idles in loading (dependent query not ready)', async () => {
    const { result } = renderHook(() => useCachedQuery<{ id: string }[]>(null))
    expect(result.current.status).toBe('loading')
    expect(result.current.data).toBeUndefined()
  })

  it('tab-visible revalidates after the throttle window (PWA resume)', async () => {
    let value = [{ id: 'v1' }]
    let calls = 0
    const q = makeQuery('resume', async () => {
      calls++
      return value
    })
    const { result } = renderHook(() => useCachedQuery(q))
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'v1' }]))
    expect(calls).toBe(1)

    // Inside the throttle window a visibility flap must NOT refetch.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(calls).toBe(1)

    // Past the window: another device changed the data; visibility pulls it.
    value = [{ id: 'v2' }]
    const realNow = Date.now()
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(realNow + VISIBLE_REFETCH_MIN_MS + 1)
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await waitFor(() => expect(result.current.data).toEqual([{ id: 'v2' }]))
      expect(calls).toBe(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('triggerCachedQueryRefetch revalidates mounted hooks (SW push broadcast)', async () => {
    let value = [{ id: 'v1' }]
    const q = makeQuery('broadcast', async () => value)
    const { result } = renderHook(() => useCachedQuery(q))
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'v1' }]))

    value = [{ id: 'v2' }]
    const realNow = Date.now()
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(realNow + VISIBLE_REFETCH_MIN_MS + 1)
    try {
      act(() => {
        triggerCachedQueryRefetch()
      })
      await waitFor(() => expect(result.current.data).toEqual([{ id: 'v2' }]))
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('refetch pulls fresh data on demand', async () => {
    let value = [{ id: 'v1' }]
    const q = makeQuery('refetchable', async () => value)
    const { result } = renderHook(() => useCachedQuery(q))
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'v1' }]))

    value = [{ id: 'v2' }]
    await act(async () => {
      await result.current.refetch()
    })
    expect(result.current.data).toEqual([{ id: 'v2' }])
  })
})
