// Planner instance of the shared render-from-cache hook. See the kit
// module for the full semantics (peek → 'stale' paint → parallel fetch →
// 'fresh'; subscription re-render; generation gate for key-change races).

import { createUseCachedQuery } from '@rallypoint/offline-kit'
import type { CachedQuery as KitCachedQuery } from '@rallypoint/offline-kit'
import type { PlannerOfflineTable } from './db.js'
import { peekCache, subscribeCache } from './cache.js'

export type CachedQuery<T> = KitCachedQuery<T, PlannerOfflineTable>
export type { CachedQueryStatus, CachedQueryResult } from '@rallypoint/offline-kit'

export const useCachedQuery = createUseCachedQuery<PlannerOfflineTable>({
  peekCache,
  subscribeCache,
})
