import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

// rate_limits — SQLite sliding-window counter store for admin-api.
// Mirrors packages/fitness-db/src/schema/rate-limits.ts.
//
// Each (tenant_id, bucket_key, window_start_ms) row is one fixed window.
// The D1 rate-limit repo does an atomic INSERT ... ON CONFLICT DO UPDATE to
// increment the current window and a plain SELECT for the previous window.
// There is no TTL/`scheduled` reaper (admin-api has no scheduled handler);
// instead the repo opportunistically reaps a bucket's stale windows inside
// takeToken on window rollover, capping each active bucket at its two live
// windows and bounding the table over time without a scheduler.

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
      name: 'admin_rate_limits_pkey',
    }),
  }),
)

export type DbAdminRateLimit = typeof rateLimits.$inferSelect
