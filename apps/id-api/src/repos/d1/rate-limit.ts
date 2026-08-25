import { createD1RateLimitRepo, type ApiKitD1Database } from '@rallypoint/api-kit'
import { rateLimits } from '@rallypoint/db'
import type { RateLimitRepo } from '@rallypoint/rate-limit'
import type { Db } from './db.js'

// Thin wrapper over @rallypoint/api-kit's shared D1 rate-limit repo (R2 dedup).
// id-api is the SSO *provider*; it consumes only the generic D1 rate-limit
// factory from api-kit (none of the SSO-consumer helpers). Its original repo
// carried no inline opportunistic prune, so opportunisticPrune stays false —
// behavior-identical to the hand-written class this replaces.
export function createRateLimitRepo(db: Db): RateLimitRepo {
  return createD1RateLimitRepo({
    db: db as unknown as ApiKitD1Database,
    table: rateLimits,
    opportunisticPrune: false,
  })
}
