import { createD1RateLimitRepo, type ApiKitD1Database } from '@rallypoint/api-kit'
import { rateLimits } from '@rallypoint/lists-db'
import type { RateLimitRepo } from '@rallypoint/rate-limit'
import type { Db } from './db.js'

// Thin wrapper over @rallypoint/api-kit's shared D1 rate-limit repo (R2 dedup).
// lists has no scheduled handler, so it prunes opportunistically on window
// rollover (opportunisticPrune: true).
export function createRateLimitRepo(db: Db): RateLimitRepo {
  return createD1RateLimitRepo({
    db: db as unknown as ApiKitD1Database,
    table: rateLimits,
    opportunisticPrune: true,
  })
}
