// Fitness instance of the shared offline read cache. Mechanics live in
// @rallypoint/offline-kit; this module binds them to the fitness Dexie
// manager and exports the app-typed helpers api.ts and the pages use.

import { createOfflineCache, isOffline, subscribeCache } from '@rallypoint/offline-kit'
import type { CachePeek } from '@rallypoint/offline-kit'
import { getDb, type FitnessOfflineTable } from './db.js'

const cache = createOfflineCache<FitnessOfflineTable>({
  getDb,
  lastUserKey: 'fitness-offline:lastUserId',
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
