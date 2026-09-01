import { createD1RateLimitRepo, type ApiKitD1Database } from '@rallypoint/api-kit'
import { rateLimits } from '@rallypoint/events-db'
import {
  createDoRateLimitRepo,
  type RateLimitCounterNamespace,
  type RateLimitRepo,
} from '@rallypoint/rate-limit'
import type { Db } from './db.js'

// Rate-limit repo selection (#881). Production (worker.ts ensureDeps) passes
// the RATE_LIMITS Durable Object namespace, moving the per-request token
// bucket off D1 (whose single storage object the old per-request write helped
// reset) onto one RateLimitCounter DO per bucket. Without a namespace — every
// existing test call site, and the rollback path if the binding is removed —
// this stays the shared D1 repo. events prunes old D1 windows on its cron
// (the pruner calls pruneOldBuckets), so the D1 branch disables the factory's
// inline opportunistic prune; the DO backend self-cleans via per-bucket
// alarms instead.
export function createRateLimitRepo(
  db: Db,
  namespace?: RateLimitCounterNamespace,
): RateLimitRepo {
  if (namespace) return createDoRateLimitRepo({ namespace })
  return createD1RateLimitRepo({
    db: db as unknown as ApiKitD1Database,
    table: rateLimits,
    opportunisticPrune: false,
  })
}
