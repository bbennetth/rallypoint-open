// IndexedDB store backing fitness-web's offline-first behaviour,
// instantiated from the shared @rallypoint/offline-kit. One per-user
// database (`fitness-offline:<userId>`) serves both the read cache and
// the outbox of queued mutations; purge-on-logout is a clean
// Dexie.delete so one user's cached training data can never leak into
// another's session on a shared/installed PWA.

import {
  createOfflineDbManager,
  type CachedRow,
  type OfflineDb,
} from '@rallypoint/offline-kit'
import type { OutboxOp } from './outbox-ops.js'

export type { CachedRow }

// One Dexie table per logical read surface. Keys are the canonical
// serialization of the read's filters (see the *Key helpers in api.ts),
// or 'all' for unfiltered reads, or `id:<id>` for cached detail rows.
// `session` carries the cached SessionDto consumed by the instant-boot
// path; `meta` is reserved cross-cutting kv state.
export type FitnessOfflineTable =
  | 'exercises'
  | 'muscleGroups'
  | 'workouts'
  | 'metrics'
  | 'insightsVolume'
  | 'insightsWeekly'
  | 'prs'
  | 'foodDaySummary'
  | 'foodFavorites'
  | 'wodTemplates'
  | 'favorites'
  | 'trainingPlans'
  | 'trainingPlanItems'
  | 'settings'
  | 'session'
  | 'meta'

// The stores exactly as version 1 shipped. Shipped versions are
// immutable — existing browsers upgrade by replaying the versions
// array, so a new table goes in a NEW version entry, never in here.
const V1_STORES = {
  exercises: 'id, fetchedAt',
  muscleGroups: 'id, fetchedAt',
  workouts: 'id, fetchedAt',
  metrics: 'id, fetchedAt',
  insightsVolume: 'id, fetchedAt',
  prs: 'id, fetchedAt',
  wodTemplates: 'id, fetchedAt',
  favorites: 'id, fetchedAt',
  trainingPlans: 'id, fetchedAt',
  trainingPlanItems: 'id, fetchedAt',
  settings: 'id, fetchedAt',
  session: 'id, fetchedAt',
  meta: 'id, fetchedAt',
} satisfies Partial<Record<FitnessOfflineTable, string>>

export type FitnessOfflineDb = OfflineDb<OutboxOp>

// Fitness adopted the kit post-extraction, so v1 carries every original
// store; later tables arrive as additive versions (planner precedent).
const manager = createOfflineDbManager<OutboxOp>({
  namePrefix: 'fitness-offline',
  versions: [
    { version: 1, stores: { ...V1_STORES, outbox: '++seq, status' } },
    // v2: the Stats weekly-volume chart cache (#762 PR6).
    { version: 2, stores: { insightsWeekly: 'id, fetchedAt' } },
    // v3: per-day kcal/macro sums, so the /log dashboard's food tile
    // paints from cache like the training half of the same page. The
    // food WRITE path stays request/response (no outbox ops) — this is
    // a read-only aggregate, same shape as insightsVolume/insightsWeekly.
    { version: 3, stores: { foodDaySummary: 'id, fetchedAt' } },
    // v4: pinned quick-log templates. Unlike the rest of the food
    // surface these DO carry outbox ops — pin/unpin is a tiny idempotent
    // toggle the server dedupes, so it queues safely offline. Re-logging
    // a pin still goes through the request/response diary write.
    { version: 4, stores: { foodFavorites: 'id, fetchedAt' } },
  ],
})

export const getDb = manager.getDb.bind(manager)
export const purgeUserDb = manager.purgeUserDb.bind(manager)
