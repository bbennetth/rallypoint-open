// IndexedDB store backing planner-web's offline-first behaviour (E4
// O3+O4), instantiated from the shared @rallypoint/offline-kit. One
// per-user database (`planner-offline:<userId>`) serves both the read
// cache and the outbox of queued mutations; purge-on-logout is a clean
// Dexie.delete so one user's cached private data can never leak into
// another's session on a shared/installed PWA.

import {
  createOfflineDbManager,
  type CachedRow,
  type OfflineDb,
} from '@rallypoint/offline-kit'
import type { OutboxOp } from './outbox-ops.js'

export type { CachedRow }

// One Dexie table per logical read surface. Keys are derived in cache.ts
// from the read's arguments (e.g. `${date}|${tz}` for the day-bounded
// reads). `session` carries the cached SessionDto consumed by the
// instant-boot path; `meta` is cross-cutting kv state (warmer stamps).
export type PlannerOfflineTable =
  | 'myDay'
  | 'upcoming'
  | 'recurring'
  | 'taskLists'
  | 'taskItems'
  | 'shoppingList'
  | 'shoppingItems'
  | 'choresList'
  | 'choreItems'
  | 'choreSeries'
  | 'diaryList'
  | 'diaryEntries'
  | 'braindumpList'
  | 'fieldDefs'
  | 'notes'
  | 'noteFolders'
  | 'personalEvents'
  | 'tickets'
  | 'holidays'
  | 'settings'
  | 'session'
  | 'meta'

// v1 stores exactly as shipped (see the version-history note below); tables
// added later live in their own additive version entries.
const CACHE_STORES: Record<Exclude<PlannerOfflineTable, 'braindumpList'>, string> = {
  myDay: 'id, fetchedAt',
  upcoming: 'id, fetchedAt',
  recurring: 'id, fetchedAt',
  taskLists: 'id, fetchedAt',
  taskItems: 'id, fetchedAt',
  shoppingList: 'id, fetchedAt',
  shoppingItems: 'id, fetchedAt',
  choresList: 'id, fetchedAt',
  choreItems: 'id, fetchedAt',
  choreSeries: 'id, fetchedAt',
  diaryList: 'id, fetchedAt',
  diaryEntries: 'id, fetchedAt',
  fieldDefs: 'id, fetchedAt',
  notes: 'id, fetchedAt',
  noteFolders: 'id, fetchedAt',
  personalEvents: 'id, fetchedAt',
  tickets: 'id, fetchedAt',
  holidays: 'id, fetchedAt',
  settings: 'id, fetchedAt',
  session: 'id, fetchedAt',
  meta: 'id, fetchedAt',
}

export type PlannerOfflineDb = OfflineDb<OutboxOp>

// Version history predates the kit extraction and must stay exactly as
// shipped: v1 = the cache stores, v2 = the additive outbox table, v3 = the
// additive braindump list cache (braindump ENTRIES share the diaryEntries
// table — generic per-list items keyed by listId). Existing browsers upgrade
// in place without data loss.
const manager = createOfflineDbManager<OutboxOp>({
  namePrefix: 'planner-offline',
  versions: [
    { version: 1, stores: CACHE_STORES },
    { version: 2, stores: { outbox: '++seq, status' } },
    { version: 3, stores: { braindumpList: 'id, fetchedAt' } },
  ],
})

export const getDb = manager.getDb.bind(manager)
export const purgeUserDb = manager.purgeUserDb.bind(manager)
