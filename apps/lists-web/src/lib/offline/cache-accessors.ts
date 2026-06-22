// Read/write helpers over the offline Dexie store. Thin wrappers that mirror
// events-web's cache accessors: every call is guarded so IndexedDB being
// unavailable (Safari private mode), quota-exceeded, or a write race degrades
// to a cache miss rather than throwing into the render path.

import type { ListsOfflineDb, ListSnapshot } from './db.js'
import type { ListDto } from '../api.js'
import { opTargetsList, type OutboxOp } from './outbox-ops.js'

export function scopeKey(scopeType: string, scopeId: string): string {
  return `${scopeType}:${scopeId}`
}

export async function readListSnapshot(
  db: ListsOfflineDb,
  listId: string,
): Promise<ListSnapshot | null> {
  try {
    const row = await db.listSnapshots.get(listId)
    return row ? row.value : null
  } catch {
    return null
  }
}

export async function writeListSnapshot(
  db: ListsOfflineDb,
  listId: string,
  value: ListSnapshot,
): Promise<void> {
  try {
    await db.listSnapshots.put({ id: listId, value, fetchedAt: Date.now() })
  } catch {
    // Quota exceeded / storage disabled — drop silently; the next read misses
    // and the network path serves the user normally.
  }
}

export async function readScopeLists(db: ListsOfflineDb, key: string): Promise<ListDto[] | null> {
  try {
    const row = await db.scopeLists.get(key)
    return row ? row.value : null
  } catch {
    return null
  }
}

export async function writeScopeLists(
  db: ListsOfflineDb,
  key: string,
  value: ListDto[],
): Promise<void> {
  try {
    await db.scopeLists.put({ id: key, value, fetchedAt: Date.now() })
  } catch {
    // See writeListSnapshot.
  }
}

// The still-pending ops scoped to one list, in FIFO order, for folding over a
// server snapshot so optimistic edits survive a refetch. Failed ops are
// excluded — they won't apply server-side, so they must not linger over the UI.
export async function readPendingOps(db: ListsOfflineDb, listId: string): Promise<OutboxOp[]> {
  try {
    const entries = await db.outbox
      .where('status')
      .anyOf(['pending', 'inflight'])
      .sortBy('seq')
    return entries.filter((e) => opTargetsList(e.op, listId)).map((e) => e.op)
  } catch {
    return []
  }
}
