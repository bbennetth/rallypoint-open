import type Dexie from 'dexie'
import { notifyCacheWrite } from './cache-subscribers.js'

// Cache-fallback read layer + optimistic write helpers, generic over the
// app's table vocabulary. An instance is created per app via
// createOfflineCache and owns the "active offline user" state that keys
// the per-user Dexie handle.
//
// cachedFetch semantics:
//   1. Hits the network first when online.
//   2. Writes successful responses into IndexedDB so a later offline
//      reload can serve them (after an optional `rebase` re-applies
//      queued outbox ops so a refetch can't wipe an optimistic row).
//   3. On transport/5xx failure OR when navigator.onLine === false,
//      returns the last cached value if present. Throws otherwise.

export interface CachePeek<T> {
  value: T
  fetchedAt: number
}

export interface CacheFetchOpts<T> {
  // If set, a cached row older than ttlMs is treated as a miss when the
  // network is also unavailable (very rare — keeps wildly-old offline data
  // from getting stuck on screen forever).
  ttlMs?: number
  // If set, applied to a successful network response before it is cached
  // and returned. The local-first write path uses this to re-apply queued
  // (not-yet-flushed) outbox ops. Not applied to cache-fallback reads —
  // the cached value already carries the optimistic mutations.
  rebase?: (fresh: T) => Promise<T> | T
}

export interface OfflineCache<TableName extends string> {
  setOfflineUser(userId: string | null): void
  getOfflineUser(): string | null
  bootOfflineUser(): void
  cachedFetch<T>(
    table: TableName,
    key: string,
    fetcher: () => Promise<T>,
    opts?: CacheFetchOpts<T>,
  ): Promise<T>
  writeCachedValue<T>(table: TableName, key: string, value: T): Promise<void>
  mutateCachedArray<T>(
    table: TableName,
    key: string,
    mutator: (current: T[]) => T[],
  ): Promise<void>
  peekCache<T>(table: TableName, key: string): Promise<CachePeek<T> | undefined>
  readMeta<T>(key: string): Promise<T | undefined>
  writeMeta<T>(key: string, value: T): Promise<void>
  readSession<T>(key: string): Promise<T | undefined>
  writeSession<T>(key: string, value: T): Promise<void>
}

export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

// Only fall back to the cache on errors that mean "the server didn't
// disagree, we just couldn't reach it" — transport failures (no .status
// on the error) and 5xx responses. Auth (401/403), not-found (404), and
// other 4xx mean the server actively rejected the request; serving stale
// cache there would hide a real signal (session revoked, resource gone).
function shouldFallBackToCache(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return true
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number') return true
  return status >= 500
}

// `getDb` returns the app's per-user Dexie handle; `lastUserKey` is the
// localStorage slot remembering the last signed-in user so a cold offline
// reload knows which Dexie DB to open before the session probe resolves.
// The 'meta' and 'session' tables are a kit convention — every consuming
// app declares them.
export function createOfflineCache<TableName extends string>(cfg: {
  getDb(userId: string): Dexie
  lastUserKey: string
}): OfflineCache<TableName> {
  let _userId: string | null = null

  function db(): Dexie | null {
    return _userId ? cfg.getDb(_userId) : null
  }

  async function readCache<T>(
    handle: Dexie | null,
    table: string,
    key: string,
    ttlMs: number | undefined,
  ): Promise<T | undefined> {
    if (!handle) return undefined
    try {
      const row = await handle.table(table).get(key)
      if (!row) return undefined
      if (ttlMs !== undefined && Date.now() - row.fetchedAt > ttlMs) {
        return undefined
      }
      return row.value as T
    } catch {
      // IndexedDB blocked (Safari private mode, quota) — degrade to a miss.
      return undefined
    }
  }

  async function writeCache<T>(
    handle: Dexie | null,
    table: string,
    key: string,
    value: T,
  ): Promise<void> {
    if (!handle) return
    try {
      await handle.table(table).put({ id: key, value, fetchedAt: Date.now() })
    } catch {
      // Quota / disabled — best-effort write; the next fetch just re-fills.
    }
    // Notify even when the IndexedDB put failed: subscribers render from the
    // in-memory value, so the UI stays correct and only persistence degrades.
    notifyCacheWrite(table, key, value)
  }

  return {
    setOfflineUser(userId: string | null): void {
      _userId = userId
      if (typeof localStorage === 'undefined') return
      try {
        if (userId) localStorage.setItem(cfg.lastUserKey, userId)
        else localStorage.removeItem(cfg.lastUserKey)
      } catch {
        // Quota / disabled — best-effort. The next session probe will retry.
      }
    },

    getOfflineUser(): string | null {
      return _userId
    },

    // Boot-time helper: rehydrate the active user from localStorage so the
    // offline DB is reachable before the session probe completes. Safe to
    // call multiple times; later setOfflineUser() calls override.
    bootOfflineUser(): void {
      if (_userId || typeof localStorage === 'undefined') return
      try {
        const stored = localStorage.getItem(cfg.lastUserKey)
        if (stored) _userId = stored
      } catch {
        // ignore
      }
    },

    async cachedFetch<T>(
      table: TableName,
      key: string,
      fetcher: () => Promise<T>,
      opts: CacheFetchOpts<T> = {},
    ): Promise<T> {
      const handle = db()

      // Skip the network entirely when the browser says we're offline.
      // Saves a round-trip to the timeout and ensures the cached value is
      // returned promptly. If there's no cached value we still throw,
      // mirroring the plain "fetch failed" UX.
      if (isOffline()) {
        const cached = await readCache<T>(handle, table, key, opts.ttlMs)
        if (cached !== undefined) return cached
        throw new Error('offline-kit: no cached value for ' + table + '/' + key)
      }

      try {
        const fetched = await fetcher()
        const fresh = opts.rebase ? await opts.rebase(fetched) : fetched
        await writeCache(handle, table, key, fresh)
        return fresh
      } catch (err) {
        if (!shouldFallBackToCache(err)) throw err
        const cached = await readCache<T>(handle, table, key, opts.ttlMs)
        if (cached !== undefined) return cached
        throw err
      }
    },

    // Overwrite a cached (non-array) value directly — settings-style
    // local-first writes use this to store the optimistically merged doc.
    // Notifies subscribers like every other cache write.
    async writeCachedValue<T>(table: TableName, key: string, value: T): Promise<void> {
      return writeCache(db(), table, key, value)
    },

    // Apply a mutator to the cached array under (table, key). Used by the
    // local-first write path to surface optimistic updates. Mutator
    // receives a shallow copy; returning the same reference is fine.
    async mutateCachedArray<T>(
      table: TableName,
      key: string,
      mutator: (current: T[]) => T[],
    ): Promise<void> {
      const handle = db()
      if (!handle) return
      try {
        const row = await handle.table(table).get(key)
        const current = ((row?.value as T[] | undefined) ?? []) as T[]
        const next = mutator([...current])
        if (next === current && row) return
        await handle
          .table(table)
          .put({ id: key, value: next, fetchedAt: row?.fetchedAt ?? Date.now() })
        notifyCacheWrite(table, key, next)
      } catch {
        // Cache unavailable — the next online read repopulates.
      }
    },

    // Read the cached row for (table, key) without touching the network.
    // Returns the value + its write timestamp so callers can decide how
    // much staleness to tolerate (useCachedQuery renders it immediately).
    async peekCache<T>(table: TableName, key: string): Promise<CachePeek<T> | undefined> {
      const handle = db()
      if (!handle) return undefined
      try {
        const row = await handle.table(table).get(key)
        if (!row) return undefined
        return { value: row.value as T, fetchedAt: row.fetchedAt }
      } catch {
        // IndexedDB blocked — degrade to a miss.
        return undefined
      }
    },

    // Direct kv helpers for the conventional `meta` and `session` tables
    // (e.g. a cached SessionDto consumed by the instant-boot path).
    async readMeta<T>(key: string): Promise<T | undefined> {
      return readCache<T>(db(), 'meta', key, undefined)
    },
    async writeMeta<T>(key: string, value: T): Promise<void> {
      return writeCache(db(), 'meta', key, value)
    },
    async readSession<T>(key: string): Promise<T | undefined> {
      return readCache<T>(db(), 'session', key, undefined)
    },
    async writeSession<T>(key: string, value: T): Promise<void> {
      return writeCache(db(), 'session', key, value)
    },
  }
}
