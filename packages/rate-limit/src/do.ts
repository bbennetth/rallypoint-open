import type { DurableObjectState } from '@cloudflare/workers-types'
import { computeBlend, windowStartMs, type RateLimitDecision } from './algorithm.js'

// RateLimitCounter — one Durable Object instance per token bucket (#881),
// keyed by idFromName(`${tenantId}:${bucketKey}`) (see do-repo.ts). Replaces
// the per-request D1 write in createD1RateLimitRepo: each bucket's counters
// live in this DO's own SQLite storage, so write pressure is distributed
// per-bucket instead of funneled through the app's single D1 storage object
// (the "storage operation exceeded timeout / object reset" failure class
// #873/#880 fought).
//
// The two-window sliding-blend algorithm is unchanged — computeBlend /
// windowStartMs from algorithm.ts — but where the D1 repo keeps one row per
// (bucket, window) and SELECTs the previous window, a single bucket's DO only
// ever needs the current and previous counts: `{ windowStartMs, count,
// prevCount }`. The DO's input gate serializes /take calls, so the
// read-modify-write is race-free without SQL upserts.
//
// Self-cleanup: every /take re-arms an alarm to now + 2×window, and the alarm
// handler deletes all storage. Because the alarm is pushed FORWARD on every
// write, it only ever fires 2×window after the *last* hit — a busy bucket can
// never have live state deleted. (Deliberately NOT RealtimeHub.ensureAlarm's
// "only set if none scheduled" shortcut, which would wipe a continuously-busy
// bucket 2×window after its first hit.) A DO with no storage and no alarm
// costs nothing, which matters here: per-IP bucket keys embed a daily-rotating
// salted hash, so fresh buckets (fresh DOs) are minted every day.

export interface TakeRequestBody {
  limit: number
  windowSeconds: number
  /** Caller-supplied clock, for tests; defaults to Date.now(). */
  nowMs?: number
}

interface BucketState {
  windowStartMs: number
  count: number
  prevCount: number
}

const BUCKET_KEY = 'bucket'

// Keep storage 2×window past the last write: the previous window stays
// blendable for one full window after rollover, so anything older than
// 2×window can never contribute to a decision again.
const CLEANUP_WINDOWS = 2

export class RateLimitCounter {
  // In-memory mirror of storage — valid for the lifetime of the isolate,
  // rehydrated from storage on the first request after a cold start. The DO
  // is single-threaded with input gates, so this never races.
  private bucket: BucketState | null | undefined

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/take') {
      const body = (await request.json()) as TakeRequestBody
      if (
        typeof body.limit !== 'number' ||
        typeof body.windowSeconds !== 'number' ||
        body.windowSeconds <= 0
      ) {
        return new Response('invalid take body', { status: 400 })
      }
      const decision = await this.take(body)
      return Response.json(decision)
    }

    if (request.method === 'POST' && url.pathname === '/reset') {
      this.bucket = null
      await this.state.storage.deleteAll()
      await this.state.storage.deleteAlarm()
      return new Response(null, { status: 204 })
    }

    return new Response('not found', { status: 404 })
  }

  private async take(body: TakeRequestBody): Promise<RateLimitDecision> {
    const windowMs = body.windowSeconds * 1000
    let nowMs = body.nowMs ?? Date.now()

    if (this.bucket === undefined) {
      this.bucket =
        ((await this.state.storage.get(BUCKET_KEY)) as BucketState | undefined) ?? null
    }

    // A caller's clock can lag the last writer's (each app passes its own
    // `now`). Never let time run backwards past the stored window — clamp
    // forward so the hit lands in the newest window we've seen. Conservative
    // (attacker-safe): counts are kept, never reset by skew.
    if (this.bucket && this.bucket.windowStartMs > windowStartMs(nowMs, windowMs)) {
      nowMs = this.bucket.windowStartMs
    }
    const currentWindow = windowStartMs(nowMs, windowMs)

    let next: BucketState
    if (this.bucket === null || this.bucket.windowStartMs < currentWindow - windowMs) {
      // First hit ever, or the bucket idled past the previous window.
      next = { windowStartMs: currentWindow, count: 1, prevCount: 0 }
    } else if (this.bucket.windowStartMs === currentWindow) {
      next = { ...this.bucket, count: this.bucket.count + 1 }
    } else {
      // Exactly one window rolled: the old current becomes the previous.
      next = { windowStartMs: currentWindow, count: 1, prevCount: this.bucket.count }
    }
    this.bucket = next
    await this.state.storage.put(BUCKET_KEY, next)
    // Unconditional re-arm — see the header comment on why this must push
    // forward on every write. Real clock, not body.nowMs: alarms are about
    // physical storage lifetime, not the caller's logical test clock.
    await this.state.storage.setAlarm(Date.now() + CLEANUP_WINDOWS * windowMs)

    const blended = computeBlend({
      currentCount: next.count,
      previousCount: next.prevCount,
      positionMs: nowMs - currentWindow,
      windowMs,
    })
    if (blended > body.limit) {
      const retryAfterMs = windowMs - (nowMs - currentWindow)
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        blendedCount: blended,
      }
    }
    return { allowed: true, retryAfterSeconds: 0, blendedCount: blended }
  }

  // Idle cleanup: fires 2×window after the last write (every write pushes the
  // alarm forward), so everything in storage is blend-irrelevant by now.
  async alarm(): Promise<void> {
    this.bucket = null
    await this.state.storage.deleteAll()
  }
}
