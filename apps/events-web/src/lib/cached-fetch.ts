import { useEffect, useRef, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import { subscribeRefresh } from './refresh-bus.js'

// Stale-while-revalidate hook that backs every attendee-shell data
// surface (slice 13). Reads from a sync-friendly cache (Dexie via
// `./cache.ts`), returns the cached value immediately if present,
// then kicks a `revalidate()` fetch and re-renders when it lands.
//
// Pages don't manage their own load-state machine any more:
//   const { data, error, isStale } = useCachedFetch({
//     key: `group:${groupId}`,
//     loadFromCache: () => readGroupDetail<GroupDetailDto>(groupId),
//     saveToCache: (v) => writeGroupDetail(groupId, v),
//     revalidate: () => getGroup(groupId),
//   })
//   if (!data && !error) return <Loading />
//   ... render data; show `isStale` indicator if you want to.

export interface UseCachedFetchOptions<T> {
  // Stable identifier for the resource. Cache reads/writes go
  // through loadFromCache/saveToCache; this is mostly for keying
  // the effect re-run.
  key: string
  loadFromCache: () => Promise<T | null>
  saveToCache: (value: T) => Promise<void>
  // Network fetch. Re-thrown on the hook's `error` slot if it
  // rejects. A successful resolve replaces both the cache and the
  // in-memory state.
  revalidate: () => Promise<T>
  // Optional: extra dependency that should also trigger a refetch
  // (e.g. a realtime-event sequence number bumped by a SSE handler).
  // Passing the same revalidationToken twice does NOT re-fetch.
  revalidationToken?: string | number | null
}

export interface CachedFetchResult<T> {
  data: T | null
  error: unknown | null
  // True when `data` came from the cache and a revalidate is in
  // flight. Once the network call lands, isStale flips to false.
  isStale: boolean
  // Manually trigger a refetch (e.g. on focus / after a mutation).
  // Updates the cache + state when it resolves.
  refresh: () => Promise<void>
}

export function useCachedFetch<T>(opts: UseCachedFetchOptions<T>): CachedFetchResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown | null>(null)
  const [isStale, setIsStale] = useState(true)
  // Generation-gated task runner (#675 R5) — replaces the hand-rolled
  // `active` boolean. Guarantees at-most-one live generation commits,
  // and closes the gate on unmount so nothing lands after teardown.
  const run = useAsyncTask()

  // Manual refresh — runs revalidate() and writes through the cache.
  // Useful for SSE handlers and post-mutation pull.
  async function refresh(): Promise<void> {
    await run(async (ctx) => {
      try {
        const fresh = await opts.revalidate()
        if (ctx.stale()) return
        setData(fresh)
        setError(null)
        setIsStale(false)
        await opts.saveToCache(fresh).catch(() => {})
      } catch (err) {
        if (ctx.stale()) return
        setError(err)
        // Keep the previously-cached data visible; only flip stale if
        // we never had any.
        setIsStale(data === null)
      }
    })
  }

  // Always-current ref so the refresh-bus subscription (keyed only on
  // opts.key) can call the latest refresh without capturing a stale closure
  // from the render when the subscription was established.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    setData(null)
    setError(null)
    setIsStale(true)

    void run(async (ctx) => {
      // Step 1: synchronous-ish read from cache.
      const cacheLoad = opts.loadFromCache().then((cached) => {
        if (ctx.stale() || cached === null) return
        setData(cached)
      })

      // Step 2: network revalidate — races the cache read, same as before.
      const revalidate = opts.revalidate().then(
        (fresh) => {
          if (ctx.stale()) return
          setData(fresh)
          setError(null)
          setIsStale(false)
          void opts.saveToCache(fresh).catch(() => {})
        },
        (err) => {
          if (ctx.stale()) return
          setError(err)
          // Don't unset `data` — let the user keep using the cached
          // copy if it loaded.
        },
      )

      await Promise.allSettled([cacheLoad, revalidate])
    })
    // Deliberately depend on the stable `key` + the optional refresh
    // token, NOT the function identities — callers usually inline
    // them so referential-equality changes every render.
  }, [run, opts.key, opts.revalidationToken])

  // Shell-driven pull-to-refresh fans out via `refresh-bus`. Every
  // cached-fetch subscriber kicks its own revalidate, write-through
  // the cache, and reconciles. No payload — the bus is just an
  // "everyone, refetch now" beacon. Re-binding on `opts.key` ensures
  // a navigation doesn't leak the previous page's closures into the
  // subscription. Use refreshRef so the subscriber always calls the
  // current refresh closure, not the one from the first render.
  useEffect(() => {
    return subscribeRefresh(() => {
      void refreshRef.current()
    })
  }, [opts.key])

  return { data, error, isStale, refresh }
}
