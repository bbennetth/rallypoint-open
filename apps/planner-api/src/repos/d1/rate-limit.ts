import { and, eq, lt, sql } from 'drizzle-orm'
import { rateLimits } from '@rallypoint/planner-db'
import {
  computeBlend,
  windowStartMs,
  type RateLimitDecision,
  type RateLimitRepo,
  type TakeTokenInput,
} from '@rallypoint/rate-limit'
import type { Db } from './db.js'

// D1 rate-limit impl for planner-api. Mirrors apps/id-api/src/repos/d1/rate-limit.ts
// exactly — atomic upsert of the current window + plain SELECT for the previous.
//
// Note: planner-api has NO cron/scheduled handler (deliberate BFF constraint).
// pruneOldBuckets() is provided for interface completeness but is never called
// from planner-api in production. Instead, takeToken() opportunistically reaps
// a bucket's stale windows on window rollover (see below), so the table stays
// bounded without a scheduler.

export class D1RateLimitRepo implements RateLimitRepo {
  constructor(private readonly db: Db) {}

  async takeToken(input: TakeTokenInput): Promise<RateLimitDecision> {
    const nowMs = (input.now ?? new Date()).getTime()
    const windowMs = input.windowSeconds * 1000
    const currentWindow = windowStartMs(nowMs, windowMs)
    const previousWindow = currentWindow - windowMs

    // Atomic upsert + increment of the current window.
    const upserted = await this.db
      .insert(rateLimits)
      .values({
        tenantId: input.tenantId,
        bucketKey: input.bucketKey,
        windowStartMs: currentWindow,
        count: 1,
      })
      .onConflictDoUpdate({
        target: [rateLimits.tenantId, rateLimits.bucketKey, rateLimits.windowStartMs],
        set: {
          count: sql`${rateLimits.count} + 1`,
          updatedAt: sql`(unixepoch() * 1000)`,
        },
      })
      .returning({ count: rateLimits.count })

    const currentCount = upserted[0]?.count ?? 1

    // Read the previous window's count.
    const prev = await this.db
      .select({ count: rateLimits.count })
      .from(rateLimits)
      .where(
        and(
          eq(rateLimits.tenantId, input.tenantId),
          eq(rateLimits.bucketKey, input.bucketKey),
          eq(rateLimits.windowStartMs, previousWindow),
        ),
      )
      .limit(1)
    const previousCount = prev[0]?.count ?? 0

    // Opportunistic pruning (planner-api is deliberately cron-free): on the
    // first hit of a new window for this bucket (currentCount === 1), drop the
    // bucket's windows older than the previous one. They can never contribute
    // to a future sliding-window blend, so this caps each actively used bucket
    // at its two live windows and bounds the table over time without a
    // scheduler — keeping planner's no-cron BFF constraint intact. Indexed by
    // the (tenant, bucket, window) PK prefix; fires at most once per window
    // per bucket.
    if (currentCount === 1) {
      await this.db
        .delete(rateLimits)
        .where(
          and(
            eq(rateLimits.tenantId, input.tenantId),
            eq(rateLimits.bucketKey, input.bucketKey),
            lt(rateLimits.windowStartMs, previousWindow),
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
  }

  async reset(tenantId: string, bucketKey: string): Promise<void> {
    await this.db
      .delete(rateLimits)
      .where(and(eq(rateLimits.tenantId, tenantId), eq(rateLimits.bucketKey, bucketKey)))
  }

  async pruneOldBuckets(olderThan: Date): Promise<number> {
    const rows = await this.db
      .delete(rateLimits)
      .where(lt(rateLimits.windowStartMs, olderThan.getTime()))
      .returning({ windowStartMs: rateLimits.windowStartMs })
    return rows.length
  }
}
