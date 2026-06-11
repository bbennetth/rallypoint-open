import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

// rate_limits — sliding-window counter store for planner-api.
//
// Schema mirrors packages/db/src/schema/rate-limits.ts (id-api's table)
// with the same PK: (tenant_id, bucket_key, window_start_ms). This is
// infrastructure, not domain storage — it does NOT violate the
// "planner-api owns no domain tables" BFF constraint (deliberate,
// see wrangler.toml + planner-v1 design doc).
//
// V1 uses a single tenant 'rallypoint' hardcoded at the middleware layer,
// mirroring id-api's approach. Tenant resolution from subdomain/OIDC is
// a Phase C concern across all apps.
//
// Pruning note: planner-api has NO cron/scheduled handler (deliberate BFF
// constraint — see wrangler.toml), so there is no time-based reaper.
// Instead D1RateLimitRepo opportunistically reaps a bucket's stale windows
// inside takeToken on window rollover (#474): each (tenant, bucket, window)
// is one row, and a bucket's windows older than the previous one are dropped
// on its next new-window hit, capping each active bucket at its two live
// windows and bounding the table over time — no scheduler, BFF constraint
// intact.

export const rateLimits = sqliteTable(
  'rate_limits',
  {
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    bucketKey: text('bucket_key').notNull(),
    windowStartMs: integer('window_start_ms').notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.tenantId, t.bucketKey, t.windowStartMs],
      name: 'planner_rate_limits_pkey',
    }),
  }),
)

export type DbPlannerRateLimit = typeof rateLimits.$inferSelect
