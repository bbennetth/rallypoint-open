// Pure in-process subscription registry for the offline read cache.
// The cache notifies after every write (network refresh, optimistic
// mutation, warmer fill) so a mounted page can re-render from the cache
// without owning the fetch that refreshed it. No Dexie, no React — unit
// testable in isolation.
//
// The registry is module-global and keyed `${table}/${key}`. Each app
// bundle gets its own module instance, and table names are app-scoped,
// so channels never collide across apps.

export type CacheListener = (value: unknown) => void

const registry = new Map<string, Set<CacheListener>>()

function channelKey(table: string, key: string): string {
  return `${table}/${key}`
}

// Subscribe to writes on (table, key). Returns an unsubscribe fn suitable
// for a useEffect cleanup. The listener receives the newly written value.
export function subscribeCache(
  table: string,
  key: string,
  listener: CacheListener,
): () => void {
  const ch = channelKey(table, key)
  let set = registry.get(ch)
  if (!set) {
    set = new Set()
    registry.set(ch, set)
  }
  set.add(listener)
  return () => {
    const current = registry.get(ch)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) registry.delete(ch)
  }
}

// Notify all listeners on (table, key). Listener errors are swallowed so
// one bad subscriber can't break the write path or its sibling listeners.
export function notifyCacheWrite(table: string, key: string, value: unknown): void {
  const set = registry.get(channelKey(table, key))
  if (!set) return
  for (const listener of [...set]) {
    try {
      listener(value)
    } catch {
      // Subscriber bug — never let it poison the cache write.
    }
  }
}

// Test-only escape hatch: drop every subscription.
export function _resetCacheSubscribers(): void {
  registry.clear()
}

// Introspection used by tests (and handy for debugging).
export function _subscriberCount(table: string, key: string): number {
  return registry.get(channelKey(table, key))?.size ?? 0
}
