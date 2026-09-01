import type { RateLimitCounterNamespace } from '@rallypoint/rate-limit'
import type { Repos } from '../types.js'
import { type Db, createDb } from './db.js'
import { createSessionsRepo } from './sessions.js'
import { createRateLimitRepo } from './rate-limit.js'

// `rateLimitNamespace` is optional so existing buildD1Repos(db) call sites
// (every *.d1.test.ts) keep exercising the D1 rate-limit path unchanged;
// only production ensureDeps passes the RATE_LIMITS DO namespace (#881).
export function buildD1Repos(db: Db, rateLimitNamespace?: RateLimitCounterNamespace): Repos {
  return {
    sessions: createSessionsRepo(db),
    rateLimit: createRateLimitRepo(db, rateLimitNamespace),
  }
}

export { createDb }
export type { Db }
