import { createD1RateLimitRepo, type ApiKitD1Database } from '@rallypoint/api-kit'
import { rateLimits } from '@rallypoint/planner-db'
import type { RateLimitRepo } from '@rallypoint/rate-limit'
import type { Db } from './db.js'

// Thin wrapper over @rallypoint/api-kit's shared D1 rate-limit repo (R2 dedup).
// planner-api is deliberately cron-free (BFF constraint), so it prunes
// opportunistically on window rollover (opportunisticPrune: true); its
// pruneOldBuckets rides along unused.
export function createRateLimitRepo(db: Db): RateLimitRepo {
  return createD1RateLimitRepo({
    db: db as unknown as ApiKitD1Database,
    table: rateLimits,
    opportunisticPrune: true,
  })
}
