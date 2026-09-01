import { env, runInDurableObject } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import type { RateLimitDecision } from './algorithm.js'
import type { RateLimitCounter } from './do.js'

// RateLimitCounter Durable Object tests — run in a real workerd isolate
// (Miniflare) via vitest.workers.config.ts, which binds COUNTER to the
// RateLimitCounter exported by test/counter-worker.ts. Each test uses its
// own bucket name (its own DO instance) so state never bleeds across tests.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const COUNTER = (env as any).COUNTER as {
  idFromName(name: string): unknown
  get(id: unknown): {
    fetch(input: string, init?: RequestInit): Promise<Response>
  }
}

function stubFor(bucket: string) {
  return COUNTER.get(COUNTER.idFromName(bucket))
}

async function take(
  bucket: string,
  args: { limit: number; windowSeconds: number; nowMs?: number },
): Promise<RateLimitDecision> {
  const res = await stubFor(bucket).fetch('https://counter/take', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as RateLimitDecision
}

// A fixed epoch aligned to every window size used below, so positionMs
// within the window is fully controlled by the offsets tests add.
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % 60_000)

describe('RateLimitCounter /take', () => {
  it('allows up to the limit within one window, then denies with Retry-After', async () => {
    const bucket = 'rallypoint:ip:h1:signin'
    for (let i = 1; i <= 3; i++) {
      const d = await take(bucket, { limit: 3, windowSeconds: 60, nowMs: T0 + i })
      expect(d).toEqual({ allowed: true, retryAfterSeconds: 0, blendedCount: i })
    }
    const denied = await take(bucket, { limit: 3, windowSeconds: 60, nowMs: T0 + 30_000 })
    expect(denied.allowed).toBe(false)
    expect(denied.blendedCount).toBe(4)
    // 30s into a 60s window → 30s until it rolls.
    expect(denied.retryAfterSeconds).toBe(30)
  })

  it('blends the previous window with a position-weighted count', async () => {
    const bucket = 'rallypoint:ip:h2:signin'
    for (let i = 0; i < 4; i++) {
      await take(bucket, { limit: 10, windowSeconds: 60, nowMs: T0 + i })
    }
    // Halfway into the NEXT window: previous count 4 weighted by 0.5 → 2,
    // plus this hit → blended 3.
    const d = await take(bucket, { limit: 10, windowSeconds: 60, nowMs: T0 + 90_000 })
    expect(d).toEqual({ allowed: true, retryAfterSeconds: 0, blendedCount: 3 })
  })

  it('resets both windows after an idle gap of more than one window', async () => {
    const bucket = 'rallypoint:ip:h3:signin'
    for (let i = 0; i < 5; i++) {
      await take(bucket, { limit: 5, windowSeconds: 60, nowMs: T0 + i })
    }
    // Two windows later, the old counts can no longer contribute.
    const d = await take(bucket, { limit: 5, windowSeconds: 60, nowMs: T0 + 120_000 })
    expect(d).toEqual({ allowed: true, retryAfterSeconds: 0, blendedCount: 1 })
  })

  it('clamps a lagging caller clock forward instead of resetting counts', async () => {
    const bucket = 'rallypoint:ip:h4:signin'
    await take(bucket, { limit: 10, windowSeconds: 60, nowMs: T0 + 60_000 })
    // A caller whose clock is a full window behind still lands in the
    // newest window (count preserved), never rewinds it.
    const d = await take(bucket, { limit: 10, windowSeconds: 60, nowMs: T0 + 1 })
    expect(d.allowed).toBe(true)
    expect(d.blendedCount).toBe(2)
  })

  it('rejects a malformed body with 400', async () => {
    const res = await stubFor('rallypoint:bad:body').fetch('https://counter/take', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    })
    expect(res.status).toBe(400)
  })
})

describe('RateLimitCounter /reset', () => {
  it('clears the bucket so the next take starts fresh', async () => {
    const bucket = 'rallypoint:user:u1:mutate'
    for (let i = 0; i < 3; i++) {
      await take(bucket, { limit: 3, windowSeconds: 60, nowMs: T0 + i })
    }
    const res = await stubFor(bucket).fetch('https://counter/reset', { method: 'POST' })
    expect(res.status).toBe(204)
    const d = await take(bucket, { limit: 3, windowSeconds: 60, nowMs: T0 + 10 })
    expect(d).toEqual({ allowed: true, retryAfterSeconds: 0, blendedCount: 1 })
  })
})

describe('RateLimitCounter persistence and cleanup', () => {
  it('persists counts in storage (survives in-memory cache loss)', async () => {
    const bucket = 'rallypoint:ip:h5:signin'
    await take(bucket, { limit: 5, windowSeconds: 60, nowMs: T0 })
    await take(bucket, { limit: 5, windowSeconds: 60, nowMs: T0 + 1 })
    const stub = stubFor(bucket)
    await runInDurableObject(stub as never, async (instance: RateLimitCounter, state) => {
      // Simulate isolate eviction: wipe the in-memory mirror, keep storage.
      ;(instance as unknown as { bucket: unknown }).bucket = undefined
      const stored = await state.storage.get('bucket')
      expect(stored).toEqual({ windowStartMs: T0, count: 2, prevCount: 0 })
    })
    const d = await take(bucket, { limit: 5, windowSeconds: 60, nowMs: T0 + 2 })
    expect(d.blendedCount).toBe(3)
  })

  it('re-arms the cleanup alarm on every take, 2 windows out', async () => {
    const bucket = 'rallypoint:ip:h6:signin'
    const stub = stubFor(bucket)
    const before = Date.now()
    await take(bucket, { limit: 5, windowSeconds: 60, nowMs: T0 })
    const first = await runInDurableObject(stub as never, (_i, state) =>
      state.storage.getAlarm(),
    )
    expect(first).not.toBeNull()
    expect(first as number).toBeGreaterThanOrEqual(before + 120_000)

    // A later hit pushes the alarm forward — a busy bucket is never wiped.
    await new Promise((r) => setTimeout(r, 5))
    await take(bucket, { limit: 5, windowSeconds: 60, nowMs: T0 + 1 })
    const second = await runInDurableObject(stub as never, (_i, state) =>
      state.storage.getAlarm(),
    )
    expect(second as number).toBeGreaterThan(first as number)
  })

  it('alarm() deletes all storage (idle bucket self-cleans)', async () => {
    const bucket = 'rallypoint:ip:h7:signin'
    await take(bucket, { limit: 5, windowSeconds: 60, nowMs: T0 })
    const stub = stubFor(bucket)
    await runInDurableObject(stub as never, async (instance: RateLimitCounter, state) => {
      await instance.alarm()
      expect(await state.storage.get('bucket')).toBeUndefined()
    })
    // Post-cleanup, counting starts from scratch.
    const d = await take(bucket, { limit: 5, windowSeconds: 60, nowMs: T0 + 1 })
    expect(d.blendedCount).toBe(1)
  })
})
