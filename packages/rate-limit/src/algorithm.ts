// Pure sliding-window rate-limit algorithm, types, and repo interface.
// No framework, no DB, no drizzle — intentionally dependency-free so
// every app can wire up its own D1 (or other) repo against this interface.
//
// Two-bucket weighted sliding window:
//   blended = current + previous * (1 - position/window)
// where position = nowMs - windowStart(nowMs, windowMs).
// "current" is the post-increment value; the decision is made before
// the increment is persisted, so callers that have already written the
// incremented row pass the post-increment count here.

export interface RateLimitDecision {
  allowed: boolean
  retryAfterSeconds: number
  // count blended across the two adjacent windows; > limit when allowed=false
  blendedCount: number
}

export interface TakeTokenInput {
  tenantId: string
  bucketKey: string
  limit: number
  windowSeconds: number
  now?: Date
}

export interface RateLimitRepo {
  takeToken(input: TakeTokenInput): Promise<RateLimitDecision>
  reset(tenantId: string, bucketKey: string): Promise<void>
  pruneOldBuckets(olderThan: Date): Promise<number>
}

// Sliding-window weight blend: given a window length W, and the
// position p in [0..W), the effective count is:
//   blended = current + previous * (1 - p/W)
//
// This treats a request that just arrived as "fully in the new
// window" and a request from W ago as fully outside. Good
// enough for V1 — two row reads per decision, no in-memory state.
export function computeBlend(args: {
  currentCount: number
  previousCount: number
  positionMs: number
  windowMs: number
}): number {
  const { currentCount, previousCount, positionMs, windowMs } = args
  if (windowMs <= 0) return currentCount
  const previousWeight = Math.max(0, 1 - positionMs / windowMs)
  return Math.floor(currentCount + previousCount * previousWeight)
}

export function windowStartMs(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs
}
