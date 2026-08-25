import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'
import {
  bootOfflineUser,
  cachedFetch,
  getOfflineUser,
  mutateCachedArray,
  peekCache,
  readSession,
  setOfflineUser,
  subscribeCache,
  writeSession,
} from './cache.js'
import { _resetCacheSubscribers } from './cache-subscribers.js'

// E4 O3 — IndexedDB read cache wrapping the planner-web fetch surface.
// Drives the real Dexie store via fake-indexeddb in jsdom; no mocks. Each
// test pins a fresh per-user DB name to keep state isolated.

let UID = 'user_test_baseline'

beforeEach(() => {
  UID = `user_test_${Math.floor(Math.random() * 1e9)}`
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

function setOnline(value: boolean): void {
  // jsdom defaults navigator.onLine to true; override per-test.
  Object.defineProperty(navigator, 'onLine', { configurable: true, value })
}

describe('cachedFetch — network-first, cache-fallback', () => {
  beforeEach(() => setOnline(true))

  it('returns the fresh value when the fetcher resolves', async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 1 })
    const result = await cachedFetch('myDay', '2026-06-25|UTC', fetcher)
    expect(result).toEqual({ value: 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('writes a successful response into the cache for later replay', async () => {
    await cachedFetch('myDay', '2026-06-25|UTC', async () => ({ value: 'first' }))

    // Force the next fetch to fail; cache should serve the prior value.
    const failing = vi.fn().mockRejectedValue(new Error('network down'))
    const replay = await cachedFetch('myDay', '2026-06-25|UTC', failing)
    expect(replay).toEqual({ value: 'first' })
  })

  it('rethrows on miss-and-failure (no cached value, fetch fails)', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(cachedFetch('myDay', 'missing-key', failing)).rejects.toThrow('boom')
  })

  it('does NOT serve cache on a 401 (session revoked) — bubbles up', async () => {
    await cachedFetch('myDay', '2026-06-25|UTC', async () => ({ value: 'old' }))

    const apiErr = Object.assign(new Error('unauthorized'), {
      name: 'ApiError',
      code: 'unauthorized',
      status: 401,
    })
    const failing = vi.fn().mockRejectedValue(apiErr)
    await expect(cachedFetch('myDay', '2026-06-25|UTC', failing)).rejects.toMatchObject({
      status: 401,
    })
  })

  it('does NOT serve cache on a 404 (resource gone) — bubbles up', async () => {
    await cachedFetch('myDay', '2026-06-25|UTC', async () => ({ value: 'old' }))
    const apiErr = Object.assign(new Error('not found'), {
      name: 'ApiError',
      status: 404,
    })
    const failing = vi.fn().mockRejectedValue(apiErr)
    await expect(cachedFetch('myDay', '2026-06-25|UTC', failing)).rejects.toMatchObject({
      status: 404,
    })
  })

  it('DOES serve cache on a 503 (server sick) — last-known is better than nothing', async () => {
    await cachedFetch('myDay', '2026-06-25|UTC', async () => ({ value: 'pre-outage' }))
    const apiErr = Object.assign(new Error('unavailable'), {
      name: 'ApiError',
      status: 503,
    })
    const failing = vi.fn().mockRejectedValue(apiErr)
    const result = await cachedFetch('myDay', '2026-06-25|UTC', failing)
    expect(result).toEqual({ value: 'pre-outage' })
  })

  it('different cache keys do not collide', async () => {
    await cachedFetch('myDay', '2026-06-25|UTC', async () => ({ value: 'A' }))
    await cachedFetch('myDay', '2026-06-26|UTC', async () => ({ value: 'B' }))

    const failing = vi.fn().mockRejectedValue(new Error('network down'))
    expect(await cachedFetch('myDay', '2026-06-25|UTC', failing)).toEqual({ value: 'A' })
    expect(await cachedFetch('myDay', '2026-06-26|UTC', failing)).toEqual({ value: 'B' })
  })

  it('ttlMs treats a stale row as a miss when the network also fails', async () => {
    await cachedFetch('myDay', '2026-06-25|UTC', async () => ({ value: 'cached' }))

    // Advance the clock past the TTL.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60 * 60 * 1000) // +1h

    const failing = vi.fn().mockRejectedValue(new Error('network down'))
    await expect(
      cachedFetch('myDay', '2026-06-25|UTC', failing, { ttlMs: 30 * 60 * 1000 }),
    ).rejects.toThrow('network down')

    vi.useRealTimers()
  })
})

describe('cachedFetch — offline mode (navigator.onLine === false)', () => {
  it('skips the network and returns the cached value', async () => {
    setOnline(true)
    await cachedFetch('myDay', '2026-06-25|UTC', async () => ({ value: 'cached-online' }))

    setOnline(false)
    const fetcher = vi.fn().mockResolvedValue({ value: 'should-not-be-called' })
    const result = await cachedFetch('myDay', '2026-06-25|UTC', fetcher)
    expect(result).toEqual({ value: 'cached-online' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('throws when offline and no cached value exists', async () => {
    setOnline(false)
    const fetcher = vi.fn().mockResolvedValue({ value: 'never' })
    await expect(cachedFetch('myDay', 'cold-key', fetcher)).rejects.toThrow(
      /no cached value/,
    )
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('cachedFetch — per-user DB isolation', () => {
  it('one user cannot read another user’s cached value', async () => {
    setOnline(true)
    setOfflineUser('user_alice')
    await cachedFetch('myDay', 'shared-key', async () => ({ value: 'alice-data' }))

    setOfflineUser('user_bob')
    // Force the network to fail so we know the response came from cache (or wasn't there).
    const failing = vi.fn().mockRejectedValue(new Error('network down'))
    await expect(cachedFetch('myDay', 'shared-key', failing)).rejects.toThrow('network down')

    await Dexie.delete('planner-offline:user_alice')
    await Dexie.delete('planner-offline:user_bob')
  })
})

describe('cachedFetch — no active user (boot before login)', () => {
  it('does not touch IndexedDB and just calls the fetcher', async () => {
    setOnline(true)
    setOfflineUser(null)
    const fetcher = vi.fn().mockResolvedValue({ value: 'live' })
    const result = await cachedFetch('myDay', 'no-user', fetcher)
    expect(result).toEqual({ value: 'live' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('throws as usual when offline and there is no user (no fallback possible)', async () => {
    setOnline(false)
    setOfflineUser(null)
    const fetcher = vi.fn().mockResolvedValue({ value: 'live' })
    await expect(cachedFetch('myDay', 'no-user', fetcher)).rejects.toThrow(/no cached value/)
  })
})

describe('peekCache — read without network', () => {
  beforeEach(() => setOnline(true))

  it('returns the cached value + fetchedAt after a cachedFetch', async () => {
    await cachedFetch('taskItems', 'list_1|UTC', async () => [{ id: 'a' }])
    const peek = await peekCache<{ id: string }[]>('taskItems', 'list_1|UTC')
    expect(peek?.value).toEqual([{ id: 'a' }])
    expect(typeof peek?.fetchedAt).toBe('number')
  })

  it('returns undefined on a cold key', async () => {
    expect(await peekCache('taskItems', 'never-fetched')).toBeUndefined()
  })

  it('returns undefined when no user is active', async () => {
    setOfflineUser(null)
    expect(await peekCache('taskItems', 'any')).toBeUndefined()
  })
})

describe('cache subscriptions — writes notify subscribers', () => {
  beforeEach(() => setOnline(true))

  it('cachedFetch success notifies the (table, key) channel', async () => {
    const cb = vi.fn()
    subscribeCache('taskItems', 'list_1|UTC', cb)
    await cachedFetch('taskItems', 'list_1|UTC', async () => [{ id: 'fresh' }])
    expect(cb).toHaveBeenCalledWith([{ id: 'fresh' }])
  })

  it('mutateCachedArray notifies with the mutated array', async () => {
    await cachedFetch('taskItems', 'list_1|UTC', async () => [{ id: 'a', done: false }])
    const cb = vi.fn()
    subscribeCache('taskItems', 'list_1|UTC', cb)
    await mutateCachedArray<{ id: string; done: boolean }>('taskItems', 'list_1|UTC', (items) =>
      items.map((i) => ({ ...i, done: true })),
    )
    expect(cb).toHaveBeenCalledWith([{ id: 'a', done: true }])
  })

  it('a cache-fallback read (network down) does NOT notify — nothing changed', async () => {
    await cachedFetch('taskItems', 'list_1|UTC', async () => [{ id: 'a' }])
    const cb = vi.fn()
    subscribeCache('taskItems', 'list_1|UTC', cb)
    await cachedFetch('taskItems', 'list_1|UTC', () => Promise.reject(new Error('down')))
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('session meta — last-known SessionDto for O2 fallback', () => {
  it('round-trips writeSession + readSession', async () => {
    await writeSession('current', { user_id: 'u123', profile: { name: 'Alice' } })
    const cached = await readSession<{ user_id: string }>('current')
    expect(cached).toEqual({ user_id: 'u123', profile: { name: 'Alice' } })
  })
})

describe('setOfflineUser / bootOfflineUser — localStorage persistence', () => {
  let storage: Map<string, string>

  beforeEach(() => {
    // Vitest 4.x jsdom omits localStorage by default; stub a real-ish one
    // so we can exercise the cross-reload rehydration code path.
    storage = new Map()
    const stub: Storage = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: (k) => void storage.delete(k),
      clear: () => storage.clear(),
      key: (i) => Array.from(storage.keys())[i] ?? null,
      get length() {
        return storage.size
      },
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: stub,
    })
  })

  it('bootOfflineUser is a no-op when a userId is already set', () => {
    setOfflineUser('user_already_known')
    storage.set('planner-offline:lastUserId', 'user_from_localstorage')
    bootOfflineUser()
    // In-memory state wins; localStorage is only consulted on cold start.
    expect(getOfflineUser()).toBe('user_already_known')
  })

  it('setOfflineUser mirrors the userId into localStorage on each call', () => {
    setOfflineUser('user_mirrored')
    expect(storage.get('planner-offline:lastUserId')).toBe('user_mirrored')
    setOfflineUser('user_switched')
    expect(storage.get('planner-offline:lastUserId')).toBe('user_switched')
  })

  it('bootOfflineUser rehydrates when the module has no active user', () => {
    setOfflineUser(null) // clear both memory + storage
    storage.set('planner-offline:lastUserId', 'user_rehydrated')
    expect(getOfflineUser()).toBeNull()
    bootOfflineUser()
    expect(getOfflineUser()).toBe('user_rehydrated')
  })

  it('signing out clears localStorage', () => {
    setOfflineUser('user_signed_in')
    expect(storage.get('planner-offline:lastUserId')).toBe('user_signed_in')
    setOfflineUser(null)
    expect(storage.get('planner-offline:lastUserId')).toBeUndefined()
  })
})
