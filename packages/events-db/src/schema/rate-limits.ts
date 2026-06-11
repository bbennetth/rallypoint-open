import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

// rate_limits — sliding-window counter store for events-api.
//
// Mirrors packages/db/src/schema/rate-limits.ts (id-api) but lives in
// the events-db package so events-api has no cross-app schema dependency.
//
// Each (tenant_id, bucket_key, window_start_ms) row is one fixed window.
// Sliding-window blends the current and previous window counts. Atomic
// increment is done via INSERT … ON CONFLICT DO UPDATE.
//
// tenant_id: events-db tables that are tenant-scoped (events, groups)
// carry the column; rate_limits mirrors id-api exactly so the same
// D1RateLimitRepo impl and takeToken call-site code works unchanged.
// V1 hardcodes 'rallypoint' via the TENANT_DEFAULT constant from
// @rallypoint/shared.
//
// Pruning: the events pruner tick (pruner.ts) calls pruneOldBuckets on
// the rateLimit repo with a 48h retention window.

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
      name: 'rate_limits_pkey',
    }),
  }),
)

export type DbEventsRateLimit = typeof rateLimits.$inferSelect
