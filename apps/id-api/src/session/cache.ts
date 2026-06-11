import type { SessionRecord } from '../repos/session.js'

// In-process LRU cache of validated sessions. Single-replica
// deploys get near-zero DB load on session validation; multi-
// replica deploys get up to TTL ms of revocation tail per replica.
// The trade-off is documented in docs/design/ — slice 3a accepts
// it for V1.
//
// Cache key = SHA-256(token) hex (the same key used as the row
// PK). Value carries the SessionRecord plus the cache insertion
// time so we can age-out on read.

interface CacheEntry {
  insertedAtMs: number
  record: SessionRecord | null // null = negative cache (token miss)
}

export interface SessionCacheOptions {
  ttlMs?: number // default 30s
  capacity?: number // default 10_000
  now?: () => number
}

export class SessionCache {
  private readonly ttlMs: number
  private readonly capacity: number
  private readonly now: () => number
  // Insertion-ordered Map gives us LRU eviction for free in V8.
  private readonly entries = new Map<string, CacheEntry>()

  constructor(opts: SessionCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30_000
    this.capacity = opts.capacity ?? 10_000
    this.now = opts.now ?? (() => Date.now())
  }

  get(idHash: string): SessionRecord | null | undefined {
    const e = this.entries.get(idHash)
    if (!e) return undefined
    if (this.now() - e.insertedAtMs > this.ttlMs) {
      this.entries.delete(idHash)
      return undefined
    }
    // Refresh LRU position by re-inserting.
    this.entries.delete(idHash)
    this.entries.set(idHash, e)
    return e.record
  }

  put(idHash: string, record: SessionRecord | null): void {
    if (this.entries.has(idHash)) this.entries.delete(idHash)
    this.entries.set(idHash, { insertedAtMs: this.now(), record })
    if (this.entries.size > this.capacity) {
      // Evict the oldest entry.
      const first = this.entries.keys().next().value
      if (first !== undefined) this.entries.delete(first)
    }
  }

  invalidate(idHash: string): void {
    this.entries.delete(idHash)
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }
}
