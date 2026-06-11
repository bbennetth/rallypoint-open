import Dexie, { type Table } from 'dexie'

// IndexedDB-backed offline cache for the attendee shell (slice 13).
// We don't ship a full sync engine — just a stale-while-revalidate
// store for the resources an attendee opens while moving through a
// festival on a flaky network: group detail, lineup, rallies, sessions,
// and the last day of chat. Each row holds the *raw* API response
// + a fetchedAt timestamp; the cached-fetch wrapper handles TTL +
// invalidation.
//
// Dexie defaults to ~50MB browser quota (per-origin LRU eviction); we
// don't pin anything. Chat is the only resource with an explicit TTL
// (~24h) because timeline scroll-back rarely re-reads stale rows.

const CHAT_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export interface CachedRow<T> {
  // Single-column primary key (resource-specific id below).
  id: string
  value: T
  fetchedAt: number // epoch ms; cheaper than a Date column on Dexie
}

export class EventsAttendeeCache extends Dexie {
  // The generic argument on Table is <T, KeyType>. We constrain the
  // primary key to the literal `id` field on each row.
  groupDetails!: Table<CachedRow<unknown>, string>
  eventLineups!: Table<CachedRow<unknown>, string>
  groupRallies!: Table<CachedRow<unknown>, string>
  eventSessions!: Table<CachedRow<unknown>, string>
  groupChat!: Table<CachedRow<unknown>, string>

  constructor() {
    super('EventsAttendeeCache')
    this.version(1).stores({
      // 'id' is the keypath; 'fetchedAt' is indexed so a future
      // background purge can sweep by age.
      groupDetails: 'id, fetchedAt',
      eventLineups: 'id, fetchedAt',
      groupRallies: 'id, fetchedAt',
      eventSessions: 'id, fetchedAt',
      groupChat: 'id, fetchedAt',
    })
  }
}

// Lazy singleton — Dexie touches `window.indexedDB` at construction,
// which throws under jsdom + Node tests. Resolving on first use means
// modules that import this file (e.g. for types) don't pay the cost
// until a cache call actually runs.
let _db: EventsAttendeeCache | null = null

function db(): EventsAttendeeCache {
  if (_db === null) _db = new EventsAttendeeCache()
  return _db
}

// --- per-resource accessors --------------------------------------

export async function readGroupDetail<T>(groupId: string): Promise<T | null> {
  return readRow<T>(db().groupDetails, groupId)
}
export async function writeGroupDetail<T>(groupId: string, value: T): Promise<void> {
  return writeRow(db().groupDetails, groupId, value)
}

export async function readEventLineup<T>(eventId: string): Promise<T | null> {
  return readRow<T>(db().eventLineups, eventId)
}
export async function writeEventLineup<T>(eventId: string, value: T): Promise<void> {
  return writeRow(db().eventLineups, eventId, value)
}

export async function readGroupRallies<T>(groupId: string): Promise<T | null> {
  return readRow<T>(db().groupRallies, groupId)
}
export async function writeGroupRallies<T>(groupId: string, value: T): Promise<void> {
  return writeRow(db().groupRallies, groupId, value)
}

export async function readEventSessions<T>(eventId: string): Promise<T | null> {
  return readRow<T>(db().eventSessions, eventId)
}
export async function writeEventSessions<T>(eventId: string, value: T): Promise<void> {
  return writeRow(db().eventSessions, eventId, value)
}

// Chat carries the TTL: a row older than CHAT_TTL_MS is treated as
// missing on read. The caller will fall back to a network fetch.
export async function readGroupChat<T>(groupId: string): Promise<T | null> {
  const row = await db().groupChat.get(groupId).catch(() => null)
  if (!row) return null
  if (Date.now() - row.fetchedAt > CHAT_TTL_MS) return null
  return row.value as T
}
export async function writeGroupChat<T>(groupId: string, value: T): Promise<void> {
  return writeRow(db().groupChat, groupId, value)
}

// --- generic helpers ---------------------------------------------

async function readRow<T>(table: Table<CachedRow<unknown>, string>, id: string): Promise<T | null> {
  try {
    const row = await table.get(id)
    return row ? (row.value as T) : null
  } catch {
    // IndexedDB unavailable (Safari private mode, etc.) → treat as miss.
    return null
  }
}

async function writeRow<T>(
  table: Table<CachedRow<unknown>, string>,
  id: string,
  value: T,
): Promise<void> {
  try {
    await table.put({ id, value, fetchedAt: Date.now() })
  } catch {
    // Quota exceeded or storage disabled — silently drop. The
    // next read returns null and the revalidate path serves the
    // user normally.
  }
}
