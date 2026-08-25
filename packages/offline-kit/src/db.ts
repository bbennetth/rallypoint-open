import Dexie, { type Table } from 'dexie'
import type { OutboxEntry } from './types.js'

// Per-user IndexedDB store backing an app's offline-first behaviour. One
// database serves both the read cache and the outbox of queued mutations
// replayed on reconnect.
//
// SECURITY: the database is named per logged-in user (`<prefix>:<userId>`)
// rather than tagging rows with a userId. Purge-on-logout is a clean
// `Dexie.delete(name)` and one user's cached private data can never leak
// into another's session on a shared/installed PWA — same cross-user-replay
// guard that keeps the apps' service workers network-only for `/api/*`.

export interface CachedRow<T> {
  id: string
  value: T
  fetchedAt: number
}

// One Dexie version declaration. Apps that shipped before adopting the
// kit keep their historical version chain (existing browsers upgrade in
// place); new apps declare a single version with every store.
export interface OfflineDbVersion {
  version: number
  stores: Record<string, string>
}

export class OfflineDb<Op> extends Dexie {
  // Queued mutations replayed on reconnect. `++seq` auto-increments and
  // is the FIFO flush order; `status` is indexed so the pending/inflight
  // count is a cheap keyed query. Dexie also exposes every declared store
  // as a property at runtime; cache tables are reached via `.table(name)`.
  outbox!: Table<OutboxEntry<Op>, number>

  constructor(name: string, versions: OfflineDbVersion[]) {
    super(name)
    for (const v of versions) {
      this.version(v.version).stores(v.stores)
    }
  }
}

export interface OfflineDbManager<Op> {
  getDb(userId: string): OfflineDb<Op>
  purgeUserDb(userId: string): Promise<void>
}

// Lazy singleton keyed by the current user. Switching users closes the
// prior handle and opens a fresh one so a stale db is never written to.
export function createOfflineDbManager<Op>(cfg: {
  namePrefix: string
  versions: OfflineDbVersion[]
}): OfflineDbManager<Op> {
  let _db: OfflineDb<Op> | null = null
  let _dbUserId: string | null = null

  return {
    getDb(userId: string): OfflineDb<Op> {
      if (_db && _dbUserId === userId) return _db
      if (_db) void _db.close()
      _db = new OfflineDb<Op>(`${cfg.namePrefix}:${userId}`, cfg.versions)
      _dbUserId = userId
      return _db
    },

    // Drop a user's entire offline store — called on sign-out and on a
    // detected user-switch. Closes the live handle first if it's the
    // active one so the delete isn't blocked by an open connection.
    async purgeUserDb(userId: string): Promise<void> {
      if (_dbUserId === userId) {
        _db?.close()
        _db = null
        _dbUserId = null
      }
      try {
        await Dexie.delete(`${cfg.namePrefix}:${userId}`)
      } catch {
        // Best-effort: a blocked/absent delete must never break sign-out.
      }
    },
  }
}
