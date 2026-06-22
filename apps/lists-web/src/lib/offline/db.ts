import Dexie, { type Table } from 'dexie'
import type { OutboxEntry } from './outbox-ops.js'
import type {
  FieldDefDto,
  LabelDto,
  ListDto,
  ListItemDto,
  ListStatusDto,
} from '../api.js'

// IndexedDB store backing the offline-first pilot (RPL). Two concerns share
// one per-user database:
//   • a read cache — a full snapshot per opened list, plus the list-of-lists
//     per scope, so reads serve last-known data when the network is gone;
//   • an outbox — pending mutations enqueued while offline and flushed on
//     reconnect.
//
// SECURITY: the database is named per logged-in user (`lists-offline:<userId>`)
// rather than tagging rows with a userId. That makes purge-on-logout a clean
// `Dexie.delete(name)` and removes any chance of one user's cached private
// list leaking into another's session on a shared/installed PWA — the same
// cross-user-replay guard that keeps the service worker network-only for
// `/api/*`.

// Everything ListDetailPage's `load()` fetches together, cached as one row so
// an offline open can rehydrate the whole page from a single read.
export interface ListSnapshot {
  list: ListDto
  items: ListItemDto[]
  fieldDefs: FieldDefDto[]
  labels: LabelDto[]
  statuses: ListStatusDto[]
  // Whether the list rendered read-only (Planner-origin) when last cached.
  readOnly: boolean
}

export interface CachedRow<T> {
  id: string
  value: T
  fetchedAt: number
}

export class ListsOfflineDb extends Dexie {
  listSnapshots!: Table<CachedRow<ListSnapshot>, string>
  scopeLists!: Table<CachedRow<ListDto[]>, string>
  outbox!: Table<OutboxEntry, number>

  constructor(userId: string) {
    super(`lists-offline:${userId}`)
    this.version(1).stores({
      listSnapshots: 'id, fetchedAt',
      scopeLists: 'id, fetchedAt',
      // `++seq` auto-increments and is the FIFO flush order; `status` is
      // indexed so the pending/inflight count is a cheap keyed query.
      outbox: '++seq, status',
    })
  }
}

// Lazy singleton keyed by the current user. Switching users closes the prior
// handle and opens a fresh one so a stale db is never written to.
let _db: ListsOfflineDb | null = null
let _dbUserId: string | null = null

export function getDb(userId: string): ListsOfflineDb {
  if (_db && _dbUserId === userId) return _db
  if (_db) void _db.close()
  _db = new ListsOfflineDb(userId)
  _dbUserId = userId
  return _db
}

// Drop a user's entire offline store — called on sign-out and on a detected
// user-switch. Closes the live handle first if it's the active one so the
// delete isn't blocked by an open connection.
export async function purgeUserDb(userId: string): Promise<void> {
  if (_dbUserId === userId) {
    _db?.close()
    _db = null
    _dbUserId = null
  }
  try {
    await Dexie.delete(`lists-offline:${userId}`)
  } catch {
    // Best-effort: a blocked/absent delete must never break sign-out.
  }
}
