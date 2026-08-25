import type { D1Database } from '@cloudflare/workers-types'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { withD1ReadRetry } from '@rallypoint/api-kit'
import * as schema from '@rallypoint/money-db'

// D1 connection factory. Unlike the Postgres pool, D1 is a per-request
// binding (env.MONEY_DB) handed to the Worker on each fetch — there is no
// long-lived pool and nothing to close. The Worker entrypoint calls
// buildD1Repos(createDb(env.MONEY_DB)); tests pass Miniflare's local D1.

export type Db = DrizzleD1Database<typeof schema>

export function createDb(d1: D1Database): Db {
  // Transient-retry decorator: every SELECT through this binding retries
  // transient D1 runtime failures (storage resets) with bounded backoff.
  return drizzle(withD1ReadRetry(d1), { schema })
}
