import { computeBlend, windowStartMs } from './algorithm.js'
import type { RateLimitDecision, RateLimitRepo, TakeTokenInput } from './algorithm.js'

// In-memory rate-limit repo. Same sliding-window math as the D1
// impl, just kept in a Map. Useful for unit tests of handlers and
// middleware in any app that depends on @rallypoint/rate-limit.

interface BucketRow {
  windowStartMs: number
  count: number
}

export class InMemoryRateLimitRepo implements RateLimitRepo {
  // key: `${tenantId}|${bucketKey}|${windowStartMs}`
  private readonly buckets = new Map<string, BucketRow>()

  async takeToken(input: TakeTokenInput): Promise<RateLimitDecision> {
    const nowMs = (input.now ?? new Date()).getTime()
    const windowMs = input.windowSeconds * 1000
    const currentWindow = windowStartMs(nowMs, windowMs)
    const previousWindow = currentWindow - windowMs

    const currentKey = this.k(input.tenantId, input.bucketKey, currentWindow)
    const previousKey = this.k(input.tenantId, input.bucketKey, previousWindow)
    const current = this.buckets.get(currentKey) ?? {
      windowStartMs: currentWindow,
      count: 0,
    }
    const previous = this.buckets.get(previousKey) ?? {
      windowStartMs: previousWindow,
      count: 0,
    }

    const nextCount = current.count + 1
    const blended = computeBlend({
      currentCount: nextCount,
      previousCount: previous.count,
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

    this.buckets.set(currentKey, { windowStartMs: currentWindow, count: nextCount })
    return { allowed: true, retryAfterSeconds: 0, blendedCount: blended }
  }

  async reset(tenantId: string, bucketKey: string): Promise<void> {
    const prefix = `${tenantId}|${bucketKey}|`
    for (const k of this.buckets.keys()) {
      if (k.startsWith(prefix)) this.buckets.delete(k)
    }
  }

  async pruneOldBuckets(olderThan: Date): Promise<number> {
    const cutoff = olderThan.getTime()
    let n = 0
    for (const [k, v] of this.buckets.entries()) {
      if (v.windowStartMs < cutoff) {
        this.buckets.delete(k)
        n++
      }
    }
    return n
  }

  private k(tenantId: string, bucketKey: string, ws: number): string {
    return `${tenantId}|${bucketKey}|${ws}`
  }
}
