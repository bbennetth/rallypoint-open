// Planner instance of the shared offline read cache (E4 O3). The
// mechanics (network-first with cache fallback, optimistic array
// mutation, peek, subscription notify) live in @rallypoint/offline-kit;
// this module binds them to the planner Dexie manager and re-exports the
// same names api.ts and the pages have always imported.

import { createOfflineCache, isOffline, subscribeCache } from '@rallypoint/offline-kit'
import type { CachePeek } from '@rallypoint/offline-kit'
import { getDb, type PlannerOfflineTable } from './db.js'

// localStorage key holding the last signed-in user — read at boot so a
// cold offline reload knows which Dexie DB to open before getSession
// has a chance to resolve.
const cache = createOfflineCache<PlannerOfflineTable>({
  getDb,
  lastUserKey: 'planner-offline:lastUserId',
})

export const setOfflineUser = cache.setOfflineUser.bind(cache)
export const getOfflineUser = cache.getOfflineUser.bind(cache)
export const bootOfflineUser = cache.bootOfflineUser.bind(cache)
export const cachedFetch = cache.cachedFetch.bind(cache)
export const writeCachedValue = cache.writeCachedValue.bind(cache)
export const mutateCachedArray = cache.mutateCachedArray.bind(cache)
export const peekCache = cache.peekCache.bind(cache)
export const readMeta = cache.readMeta.bind(cache)
export const writeMeta = cache.writeMeta.bind(cache)
export const readSession = cache.readSession.bind(cache)
export const writeSession = cache.writeSession.bind(cache)

export type { CachePeek }
export { isOffline, subscribeCache }
