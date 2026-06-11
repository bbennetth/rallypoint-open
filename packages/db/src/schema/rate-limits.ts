import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

// rate_limits — SQLite-backed sliding-window counter store.
//
// Each (tenant_id, bucket_key, window_start_ms) row is one fixed
// window. To make a sliding-window decision we read the *current*
// window AND the *previous* window, weight-blend them against the
// current "position within the window," and decide against the
// configured limit. Atomic increment is done via INSERT ... ON
// CONFLICT DO UPDATE.
//
// Pruning: a periodic loop (slice 3a's TTL pruner) cleans rows
// whose window_start_ms is older than the longest configured window.
// We use a 1-hour ceiling for V1 — any bucket older than `now - 2h`
// is unreachable.

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

export type DbRateLimit = typeof rateLimits.$inferSelect
