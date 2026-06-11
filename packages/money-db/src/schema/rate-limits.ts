import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

// rate_limits — SQLite sliding-window counter store for money-api.
// Mirrors packages/db/src/schema/rate-limits.ts (used by id-api).
//
// Each (tenant_id, bucket_key, window_start_ms) row is one fixed
// window. The D1RateLimitRepo does an atomic INSERT ... ON CONFLICT
// DO UPDATE to increment the current window and a plain SELECT for
// the previous window. There is no TTL/`scheduled` reaper (money-api has
// no scheduled worker handler); instead D1RateLimitRepo opportunistically
// reaps a bucket's stale windows inside takeToken on window rollover
// (#474), capping each active bucket at its two live windows and bounding
// the table over time without a scheduler.

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
      name: 'money_rate_limits_pkey',
    }),
  }),
)

export type DbMoneyRateLimit = typeof rateLimits.$inferSelect
