import { and, eq, lt, sql } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import {
  computeBlend,
  windowStartMs,
  type RateLimitDecision,
  type RateLimitRepo,
  type TakeTokenInput,
} from '@rallypoint/rate-limit'
import { withD1Retry } from '../d1-retry.js'
import type { ApiKitD1Database } from './sessions.js'

// Shared D1 rate-limit repository (R2 dedup). The token-bucket ALGORITHM already
// lives in @rallypoint/rate-limit (computeBlend / windowStartMs); this is only
// the D1 SQL glue that was copy-pasted into all 5 consumer apps (and id-api).
// Atomic increment of the current window via INSERT ... ON CONFLICT DO UPDATE +
// RETURNING; the previous window is a plain SELECT (eventually consistent —
// overcounting is fine, undercounting is the worry).
//
// One divergence, selected by `opportunisticPrune`: events prunes old windows
// on a cron (its pruner calls pruneOldBuckets), so its takeToken skips the
// inline prune; the other apps have no scheduler and prune opportunistically on
// window rollover. Schema-agnostic: each app passes its own `rateLimits` table.

export interface CreateD1RateLimitRepoConfig {
  db: ApiKitD1Database
  /** The app's drizzle `rateLimits` table. */
  table: SQLiteTable
  /**
   * When true, on the first hit of a new window (currentCount === 1) drop this
   * bucket's windows older than the previous one — they can never contribute to
   * a future sliding-window blend, so this bounds the table without a scheduler.
   * Events sets false (its cron calls pruneOldBuckets instead).
   */
  opportunisticPrune: boolean
}

// The columns the factory references by name. The concrete per-app table is
// structurally wider; we cast to reach them.
type RateLimitsTable = SQLiteTable & {
  tenantId: SQLiteColumn
  bucketKey: SQLiteColumn
  windowStartMs: SQLiteColumn
  count: SQLiteColumn
}

export function createD1RateLimitRepo(config: CreateD1RateLimitRepoConfig): RateLimitRepo {
  const { db, opportunisticPrune } = config
  const table = config.table as RateLimitsTable

  return {
    async takeToken(input: TakeTokenInput): Promise<RateLimitDecision> {
      const nowMs = (input.now ?? new Date()).getTime()
      const windowMs = input.windowSeconds * 1000
      const currentWindow = windowStartMs(nowMs, windowMs)
      const previousWindow = currentWindow - windowMs

      // Atomic upsert + increment of the current window.
      //
      // This is the one INSERT the d1-retry header's "never retry an INSERT"
      // rule doesn't apply to. That rule exists because an ambiguous retry can
      // double-apply a write; here the worst case is a token counted twice, so
      // the bucket runs slightly strict for one window and self-heals at the
      // rollover. A transient D1 failure with no retry, by contrast, is a
      // user-facing 500 on every rate-limited route.
      const upserted = await withD1Retry(() =>
        db
          .insert(table)
          .values({
            tenantId: input.tenantId,
            bucketKey: input.bucketKey,
            windowStartMs: currentWindow,
            count: 1,
          } as never)
          .onConflictDoUpdate({
            target: [table.tenantId, table.bucketKey, table.windowStartMs],
            set: {
              count: sql`${table.count} + 1`,
              updatedAt: sql`(unixepoch() * 1000)`,
            },
          })
          .returning({ count: table.count }),
      )

      const currentCount = (upserted[0]?.count as number | undefined) ?? 1

      // Read the previous window's count. Deliberately NOT wrapped in
      // withD1Retry: every app hands createDb a binding already wrapped in
      // withD1ReadRetry, which retries SELECTs transparently. Wrapping again
      // would nest 3 attempts inside 3 for ~9 round-trips and ~800ms of
      // backoff on one statement — piling load onto D1 during exactly the
      // overload the retry exists to survive.
      const prev = await db
        .select({ count: table.count })
        .from(table)
        .where(
          and(
            eq(table.tenantId, input.tenantId),
            eq(table.bucketKey, input.bucketKey),
            eq(table.windowStartMs, previousWindow),
          ),
        )
        .limit(1)
      const previousCount = (prev[0]?.count as number | undefined) ?? 0

      // Opportunistic pruning (apps without a scheduled handler): on the first
      // hit of a new window for this bucket, drop windows older than the
      // previous one. Fires at most once per window per bucket, PK-indexed.
      if (opportunisticPrune && currentCount === 1) {
        await withD1Retry(() =>
          db
            .delete(table)
            .where(
              and(
                eq(table.tenantId, input.tenantId),
                eq(table.bucketKey, input.bucketKey),
                lt(table.windowStartMs, previousWindow),
              ),
            ),
        )
      }

      const blended = computeBlend({
        currentCount,
        previousCount,
        positionMs: nowMs - currentWindow,
        windowMs,
      })

      if (blended > input.limit) {
        const retryAfterMs = windowMs - (nowMs - currentWindow)
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
          blendedCount: blended,
        }
      }
      return { allowed: true, retryAfterSeconds: 0, blendedCount: blended }
    },

    async reset(tenantId: string, bucketKey: string): Promise<void> {
      await db
        .delete(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.bucketKey, bucketKey)))
    },

    async pruneOldBuckets(olderThan: Date): Promise<number> {
      const rows = await db
        .delete(table)
        .where(lt(table.windowStartMs, olderThan.getTime()))
        .returning({ windowStartMs: table.windowStartMs })
      return rows.length
    },
  }
}
