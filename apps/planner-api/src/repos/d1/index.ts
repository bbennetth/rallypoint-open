import type { Repos } from '../types.js'
import { type Db, createDb } from './db.js'
import { D1PlannerSessionRepo } from './sessions.js'
import { D1RateLimitRepo } from './rate-limit.js'

export function buildD1Repos(db: Db): Repos {
  return {
    sessions: new D1PlannerSessionRepo(db),
    rateLimit: new D1RateLimitRepo(db),
  }
}

export { createDb }
export type { Db }
