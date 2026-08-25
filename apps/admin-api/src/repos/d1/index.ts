import type { Repos } from '../types.js'
import { type Db, createDb } from './db.js'
import { createSessionsRepo } from './sessions.js'
import { createRateLimitRepo } from './rate-limit.js'

export function buildD1Repos(db: Db): Repos {
  return {
    sessions: createSessionsRepo(db),
    rateLimit: createRateLimitRepo(db),
  }
}

export { createDb }
export type { Db }
