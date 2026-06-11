import type { D1Database } from '@cloudflare/workers-types'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import * as schema from '@rallypoint/lists-db'

// D1 connection factory. Unlike the Postgres pool, D1 is a per-request
// binding (env.LISTS_DB) handed to the Worker on each fetch — there is no
// long-lived pool and nothing to close. The Worker entrypoint (Phase 2)
// calls buildD1Repos(createDb(env.LISTS_DB)); tests pass Miniflare's local D1.

export type Db = DrizzleD1Database<typeof schema>

export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema })
}
