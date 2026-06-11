import { and, eq, lt, sql } from 'drizzle-orm'
import { rateLimits } from '@rallypoint/events-db'
import {
  computeBlend,
  windowStartMs,
  type RateLimitDecision,
  type RateLimitRepo,
  type TakeTokenInput,
} from '@rallypoint/rate-limit'
import type { Db } from './db.js'

// D1 rate-limit impl for events-api. Mirrors apps/id-api/src/repos/d1/rate-limit.ts
// but imports from @rallypoint/events-db instead of @rallypoint/db so
// events-api has no cross-app schema dependency.

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
