import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { buildD1Repos, createDb } from './index.js'
import type { Repos } from '../types.js'

// D1 test for the opportunistic rate-limit pruning added in #474.
// takeToken reaps a bucket's stale windows (older than the previous window)
// on the first hit of a new window — no cron, no scheduled handler.

const WINDOW_S = 600
const WINDOW_MS = WINDOW_S * 1000
// A clean window boundary so windowStart(T) === T.
const T = 100 * WINDOW_MS

async function seedWindow(bucket: string, windowStartMs: number, count: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO rate_limits (tenant_id, bucket_key, window_start_ms, count) VALUES (?, ?, ?, ?)',
  )
    .bind('rallypoint', bucket, windowStartMs, count)
    .run()
}

async function windowsFor(bucket: string): Promise<number[]> {
  const res = await env.DB.prepare(
    'SELECT window_start_ms FROM rate_limits WHERE tenant_id = ? AND bucket_key = ? ORDER BY window_start_ms',
  )
    .bind('rallypoint', bucket)
    .all<{ window_start_ms: number }>()
  return res.results.map((r) => r.window_start_ms)
}

describe('D1 rate-limit opportunistic pruning (#474)', () => {
  let repos: Repos
  const take = (bucket: string, nowMs: number) =>
    repos.rateLimit.takeToken({
      tenantId: 'rallypoint',
      bucketKey: bucket,
      limit: 10,
      windowSeconds: WINDOW_S,
      now: new Date(nowMs),
    })

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM rate_limits')
    repos = buildD1Repos(createDb(env.DB))
  })

  it('reaps windows older than the previous one on rollover and keeps the live count intact', async () => {
    const bucket = 'ip:1.2.3.4'
    // Accumulated stale windows (as if no reaper had ever run), plus the
    // immediately-previous window carrying a real count.
    await seedWindow(bucket, T - 3 * WINDOW_MS, 3)
    await seedWindow(bucket, T - 2 * WINDOW_MS, 2)
    await seedWindow(bucket, T - WINDOW_MS, 4)
    expect(await windowsFor(bucket)).toEqual([T - 3 * WINDOW_MS, T - 2 * WINDOW_MS, T - WINDOW_MS])

    // First hit of the current window: currentCount === 1 triggers the reap of
    // everything strictly older than previousWindow(T) === T - WINDOW_MS.
    const decision = await take(bucket, T)

    // Only the previous + current windows survive.
    expect(await windowsFor(bucket)).toEqual([T - WINDOW_MS, T])
    // The previous window (count 4) is preserved, so the blend is unaffected:
    // position 0 → current(1) + previous(4) * 1 = 5.
    expect(decision.blendedCount).toBe(5)
    expect(decision.allowed).toBe(true)
  })

  it('only reaps the bucket being hit, never other buckets', async () => {
    const hot = 'ip:hot'
    const cold = 'ip:cold'
    await seedWindow(hot, T - 9 * WINDOW_MS, 1)
    await seedWindow(cold, T - 9 * WINDOW_MS, 1)

    await take(hot, T)

    // Hot bucket's ancient window reaped (no previous seeded → just current).
    expect(await windowsFor(hot)).toEqual([T])
    // Cold bucket is untouched — pruning is scoped to the hit bucket.
    expect(await windowsFor(cold)).toEqual([T - 9 * WINDOW_MS])
  })

  it('does NOT reap mid-window (only on the rollover hit, currentCount === 1)', async () => {
    const bucket = 'ip:9.9.9.9'
    // Current window already has traffic + an accumulated ancient window.
    await seedWindow(bucket, T, 5)
    await seedWindow(bucket, T - 8 * WINDOW_MS, 1)

    // This hit increments the current window to 6 (currentCount !== 1), so the
    // reap is skipped and the ancient window is left for a future rollover.
    const decision = await take(bucket, T)
    expect(decision.blendedCount).toBe(6)

    expect(await windowsFor(bucket)).toEqual([T - 8 * WINDOW_MS, T])
  })
})
