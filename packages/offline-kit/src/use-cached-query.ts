// Render-from-cache React hook (the SWR layer). On mount it peeks
// IndexedDB and renders the cached value immediately (status 'stale'),
// while the network fetch runs in parallel; when the fresh response
// lands the page re-renders (status 'fresh'). It also subscribes to the
// (table, key) channel so cache writes from anywhere — optimistic
// mutations, outbox reconciles, a cache warmer, another page's fetch —
// re-render this one.
//
// A true cold miss (no cached row yet) keeps status 'loading' until the
// fetch resolves — that's the only case a page should show a skeleton.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CachePeek } from './cache.js'

// A read surface descriptor: where the cache row lives + how to refresh
// it. `fetch` must be the app's reader (it goes through cachedFetch, so
// a success writes the cache and notifies subscribers — including us).
export interface CachedQuery<T, TableName extends string = string> {
  table: TableName
  key: string
  fetch: () => Promise<T>
}

export type CachedQueryStatus = 'loading' | 'stale' | 'fresh' | 'error'

export interface CachedQueryResult<T> {
  data: T | undefined
  // loading: cold miss, fetch in flight — show a skeleton.
  // stale: rendering cached data; a refresh is (or was) in flight.
  // fresh: the data on screen came back from the server this mount.
  // error: fetch failed AND there is no cached data to show.
  status: CachedQueryStatus
  error: unknown
  refetch: () => Promise<void>
}

export type UseCachedQuery<TableName extends string> = <T>(
  query: CachedQuery<T, TableName> | null,
) => CachedQueryResult<T>

// Skip a visibility/broadcast-triggered refetch when a fetch settled less
// than this long ago — guards against visibility flapping (e.g. quick
// app-switch bounces) hammering the BFF.
export const VISIBLE_REFETCH_MIN_MS = 5_000

// Pure decision: has enough time passed since the last settled fetch to
// bother refetching? An unknown lastFetchAt (no fetch settled yet) always
// allows — the in-flight fetch will win via the generation gate anyway.
export function shouldRefetchOnVisible(lastFetchAt: number | undefined, now: number): boolean {
  if (lastFetchAt === undefined) return true
  return now - lastFetchAt >= VISIBLE_REFETCH_MIN_MS
}

// Module-level registry of every mounted hook's refetch, so out-of-band
// signals (the SW's push broadcast, a future BroadcastChannel) can force
// all visible queries to revalidate without prop-drilling.
const refetchRegistry = new Set<() => void>()

/**
 * Re-run the fetch of every mounted useCachedQuery hook. Each hook applies
 * its own VISIBLE_REFETCH_MIN_MS throttle, so calling this in bursts is safe.
 */
export function triggerCachedQueryRefetch(): void {
  for (const fn of refetchRegistry) fn()
}

export function createUseCachedQuery<TableName extends string>(cfg: {
  peekCache<T>(table: TableName, key: string): Promise<CachePeek<T> | undefined>
  subscribeCache(table: TableName, key: string, listener: (value: unknown) => void): () => void
}): UseCachedQuery<TableName> {
  return function useCachedQuery<T>(
    query: CachedQuery<T, TableName> | null,
  ): CachedQueryResult<T> {
    const [data, setData] = useState<T | undefined>(undefined)
    const [status, setStatus] = useState<CachedQueryStatus>('loading')
    const [error, setError] = useState<unknown>(null)

    // The latest descriptor, readable from stable callbacks without
    // widening the effect deps to the (unstable) object identity.
    const queryRef = useRef(query)
    queryRef.current = query
    // Generation gate: a slow fetch for a previous key must not clobber
    // the state of the current one.
    const genRef = useRef(0)
    // When the last fetch settled — feeds the visibility-refetch throttle.
    const lastFetchAtRef = useRef<number | undefined>(undefined)

    const table = query?.table
    const key = query?.key

    const runFetch = useCallback(async (gen: number) => {
      const q = queryRef.current
      if (!q) return
      try {
        const fresh = await q.fetch()
        lastFetchAtRef.current = Date.now()
        if (genRef.current !== gen) return
        setData(fresh)
        setStatus('fresh')
        setError(null)
      } catch (err) {
        lastFetchAtRef.current = Date.now()
        if (genRef.current !== gen) return
        setError(err)
        // Keep showing cached data when we have it; only a data-less
        // failure is a hard error state.
        setStatus((prev) => (prev === 'loading' ? 'error' : prev))
      }
    }, [])

    useEffect(() => {
      if (!table || !key) {
        // Dependent query not ready (e.g. items waiting on a listId).
        setData(undefined)
        setStatus('loading')
        setError(null)
        return
      }
      const gen = ++genRef.current
      setData(undefined) // key changed — never show the previous key's rows
      setStatus('loading')
      setError(null)

      // Peek the cache and render it immediately — unless the fetch (or a
      // subscription notify) already delivered something newer.
      void cfg.peekCache<T>(table, key).then((hit) => {
        if (genRef.current !== gen || hit === undefined) return
        setData((prev) => (prev === undefined ? hit.value : prev))
        setStatus((prev) => (prev === 'loading' ? 'stale' : prev))
      })

      void runFetch(gen)

      // Any cache write on this channel re-renders the page: optimistic
      // mutations, outbox drain reconciles, a warmer, sibling pages.
      const unsubscribe = cfg.subscribeCache(table, key, (value) => {
        if (genRef.current !== gen) return
        setData(value as T)
        setStatus((prev) => (prev === 'loading' ? 'stale' : prev))
      })

      // Re-open of an installed PWA usually *resumes* the page (no remount),
      // so edits from another device would sit stale until something else
      // happened to fetch. Revalidate whenever the tab regains visibility —
      // the same pattern the outbox flusher and SW update check use.
      const throttledRefetch = (): void => {
        if (!shouldRefetchOnVisible(lastFetchAtRef.current, Date.now())) return
        void runFetch(genRef.current)
      }
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') throttledRefetch()
      }
      document.addEventListener('visibilitychange', onVisible)
      // Same refetch, driven by out-of-band signals (SW push broadcast).
      refetchRegistry.add(throttledRefetch)

      return () => {
        unsubscribe()
        document.removeEventListener('visibilitychange', onVisible)
        refetchRegistry.delete(throttledRefetch)
        // Invalidate in-flight work for this key on unmount/key-change.
        if (genRef.current === gen) genRef.current++
      }
    }, [table, key, runFetch])

    const refetch = useCallback(async () => {
      await runFetch(genRef.current)
    }, [runFetch])

    return { data, status, error, refetch }
  }
}
