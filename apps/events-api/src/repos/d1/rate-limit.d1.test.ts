import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { buildD1Repos, createDb } from './index.js'
import type { Repos } from '../types.js'

// D1 test for the events rate-limit repo (R2: shared @rallypoint/api-kit factory
// with opportunisticPrune:false). events reaps stale windows on its cron
// (pruneOldBuckets), NOT inline — so takeToken must leave old windows untouched,
// unlike the other apps. Locks in the divergence the factory's flag encodes;
// the inline-prune side is covered by lists/money/planner's repo tests.

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

describe('events D1 rate-limit (opportunisticPrune: false — cron-pruned)', () => {
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

  it('does NOT reap stale windows inline on rollover (events relies on its cron)', async () => {
    const bucket = 'ip:1.2.3.4'
    await seedWindow(bucket, T - 3 * WINDOW_MS, 3)
    await seedWindow(bucket, T - 2 * WINDOW_MS, 2)
    await seedWindow(bucket, T - WINDOW_MS, 4)

    // First hit of the current window (currentCount === 1). With inline pruning
    // OFF, every stale window survives — only the new current window is added.
    const decision = await take(bucket, T)

    expect(await windowsFor(bucket)).toEqual([
      T - 3 * WINDOW_MS,
      T - 2 * WINDOW_MS,
      T - WINDOW_MS,
      T,
    ])
    // The blend still uses only the previous window (count 4): current(1) + 4 = 5.
    expect(decision.blendedCount).toBe(5)
    expect(decision.allowed).toBe(true)
  })

  it('pruneOldBuckets (the cron path) deletes windows older than the cutoff', async () => {
    const bucket = 'ip:5.6.7.8'
    await seedWindow(bucket, T - 3 * WINDOW_MS, 1)
    await seedWindow(bucket, T - WINDOW_MS, 1)
    await seedWindow(bucket, T, 1)

    // Reap everything strictly older than T - WINDOW_MS.
    const deleted = await repos.rateLimit.pruneOldBuckets(new Date(T - WINDOW_MS))
    expect(deleted).toBe(1)
    expect(await windowsFor(bucket)).toEqual([T - WINDOW_MS, T])
  })
})
