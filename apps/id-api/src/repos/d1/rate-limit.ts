import { createD1RateLimitRepo, type ApiKitD1Database } from '@rallypoint/api-kit'
import { rateLimits } from '@rallypoint/db'
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
// this stays the shared D1 repo (@rallypoint/api-kit's factory; id-api is the
// SSO *provider* and consumes only the generic D1 rate-limit factory, none of
// the SSO-consumer helpers). Its original repo carried no inline
// opportunistic prune, so opportunisticPrune stays false — behavior-identical
// to the hand-written class this replaces.
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
