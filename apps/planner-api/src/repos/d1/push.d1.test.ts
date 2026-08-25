import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { buildD1Repos, createDb } from './index.js'
import type { Repos } from '../types.js'
import { deliverNotification, runNotificationTick } from '../../lib/notifications.js'
import type { WebPushService } from '../../services/types.js'

// Real workerd + Miniflare D1 (run: `npm run test:d1:planner`). Exercises the
// two notification infra tables against the actual migration-applied schema.

// Stubbed Web Push — the D1 state transitions (claim/sent/attempts/reap) are
// what's under test, not RFC 8291 crypto (covered in packages/web-push). The
// gate lets a test park a send mid-flight to exercise the claim race window.
function stubPush(behavior: (endpoint: string) => { ok: boolean; statusCode: number; expired: boolean }): {
  service: WebPushService
  sent: string[]
  gate: { promise: Promise<void> | null }
} {
  const sent: string[] = []
  const gate: { promise: Promise<void> | null } = { promise: null }
  return {
    sent,
    gate,
    service: {
      async send(sub, _payload) {
        sent.push(sub.endpoint)
        if (gate.promise) await gate.promise
        return behavior(sub.endpoint)
      },
    },
  }
}

describe('D1 push_subscriptions + scheduled_notifications', () => {
  let repos: Repos
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM push_subscriptions')
    await env.DB.exec('DELETE FROM scheduled_notifications')
    repos = buildD1Repos(createDb(env.DB))
  })

  it('upserts a subscription by endpoint hash (re-subscribe refreshes keys)', async () => {
    await repos.pushSubscriptions.upsert({
      idHash: 'hash_a',
      userId: 'user_1',
      endpoint: 'https://push.example.com/a',
      p256dh: 'key1',
      auth: 'auth1',
    })
    await repos.pushSubscriptions.upsert({
      idHash: 'hash_a',
      userId: 'user_1',
      endpoint: 'https://push.example.com/a',
      p256dh: 'key2',
      auth: 'auth2',
    })
    const subs = await repos.pushSubscriptions.listByUser('user_1')
    expect(subs).toHaveLength(1)
    expect(subs[0]!.p256dh).toBe('key2')
  })

  it('markSuccess stamps lastSuccessAt', async () => {
    await repos.pushSubscriptions.upsert({
      idHash: 'h1', userId: 'user_1', endpoint: 'https://p/1', p256dh: 'k', auth: 'a',
    })
    const when = new Date('2026-06-17T12:00:00.000Z')
    await repos.pushSubscriptions.markSuccess('h1', when)
    const subs = await repos.pushSubscriptions.listByUser('user_1')
    expect(subs[0]!.lastSuccessAt?.toISOString()).toBe(when.toISOString())
  })

  it('lists only a user’s own subscriptions and deletes by hash', async () => {
    await repos.pushSubscriptions.upsert({
      idHash: 'h1', userId: 'user_1', endpoint: 'https://p/1', p256dh: 'k', auth: 'a',
    })
    await repos.pushSubscriptions.upsert({
      idHash: 'h2', userId: 'user_2', endpoint: 'https://p/2', p256dh: 'k', auth: 'a',
    })
    expect(await repos.pushSubscriptions.listByUser('user_1')).toHaveLength(1)
    await repos.pushSubscriptions.deleteByIdHash('h1')
    expect(await repos.pushSubscriptions.listByUser('user_1')).toHaveLength(0)
    expect(await repos.pushSubscriptions.listByUser('user_2')).toHaveLength(1)
  })

  it('upserts a scheduled notification by (user, dedupeKey) and lists due rows', async () => {
    const t1 = new Date('2026-06-17T18:00:00.000Z')
    const now = new Date('2026-06-17T12:00:00.000Z')
    await repos.scheduledNotifications.upsert(
      { id: 'psn_1', userId: 'user_1', dedupeKey: 'event:e1', source: 'event', title: 'A', body: null, url: 'https://x', fireAt: t1 },
      now,
    )
    // Not due yet.
    expect(await repos.scheduledNotifications.listDue(now, 10)).toHaveLength(0)
    // Edit (same dedupe) reschedules in place — still one row.
    const t2 = new Date('2026-06-17T11:00:00.000Z')
    await repos.scheduledNotifications.upsert(
      { id: 'psn_2', userId: 'user_1', dedupeKey: 'event:e1', source: 'event', title: 'A edited', body: 'b', url: 'https://x', fireAt: t2 },
      now,
    )
    const due = await repos.scheduledNotifications.listDue(now, 10)
    expect(due).toHaveLength(1)
    expect(due[0]!.title).toBe('A edited')
    expect(due[0]!.fireAt.toISOString()).toBe(t2.toISOString())
  })

  it('cancel hides a row from the due list; markSent retires it', async () => {
    const now = new Date('2026-06-17T12:00:00.000Z')
    const past = new Date('2026-06-17T11:00:00.000Z')
    await repos.scheduledNotifications.upsert(
      { id: 'psn_1', userId: 'user_1', dedupeKey: 'event:e1', source: 'event', title: 'A', body: null, url: 'https://x', fireAt: past },
      now,
    )
    expect(await repos.scheduledNotifications.listDue(now, 10)).toHaveLength(1)
    await repos.scheduledNotifications.cancel('user_1', 'event:e1', now)
    expect(await repos.scheduledNotifications.listDue(now, 10)).toHaveLength(0)

    // A fresh enqueue revives it (clears cancelled), then markSent retires it.
    await repos.scheduledNotifications.upsert(
      { id: 'psn_3', userId: 'user_1', dedupeKey: 'event:e1', source: 'event', title: 'A', body: null, url: 'https://x', fireAt: past },
      now,
    )
    const due = await repos.scheduledNotifications.listDue(now, 10)
    expect(due).toHaveLength(1)
    await repos.scheduledNotifications.markSent(due[0]!.id, now)
    expect(await repos.scheduledNotifications.listDue(now, 10)).toHaveLength(0)
  })

  it('round-trips tz + recurrence for a chore (series) row', async () => {
    const now = new Date('2026-06-17T12:00:00.000Z')
    const fire = new Date('2026-06-18T09:00:00.000Z')
    const rule = JSON.stringify({ freq: 'daily', interval: 1, byDay: null, dtstart: '2026-06-01', until: null, count: null, timeOfDay: '09:00' })
    await repos.scheduledNotifications.upsert(
      { id: 'psn_c', userId: 'user_1', dedupeKey: 'series:s1', source: 'chore', title: 'Dishes', body: null, url: 'https://x', fireAt: fire, tz: 'America/New_York', recurrence: rule },
      now,
    )
    const due = await repos.scheduledNotifications.listDue(fire, 10)
    expect(due).toHaveLength(1)
    expect(due[0]!.tz).toBe('America/New_York')
    expect(JSON.parse(due[0]!.recurrence!).timeOfDay).toBe('09:00')
  })

  it('recordFailure increments attempts and reverts the claim below the cap', async () => {
    const now = new Date('2026-06-17T12:00:00.000Z')
    const past = new Date('2026-06-17T11:00:00.000Z')
    await repos.scheduledNotifications.upsert(
      { id: 'psn_1', userId: 'user_1', dedupeKey: 'event:e1', source: 'event', title: 'A', body: null, url: 'https://x', fireAt: past },
      now,
    )
    // recordFailure now guards on the caller's claim: claim, then fail.
    expect(await repos.scheduledNotifications.claimForSend('psn_1', now)).toBe(true)
    expect(await repos.scheduledNotifications.recordFailure('psn_1', 'boom', now, 5)).toBe(1)
    // Below the cap the claim is reverted, so the row is due again.
    const due = await repos.scheduledNotifications.listDue(now, 10)
    expect(due).toHaveLength(1)
    expect(due[0]!.attempts).toBe(1)
    expect(due[0]!.lastError).toBe('boom')
  })
})

// The 2.1 race fix: claim-before-send serialization + its claim-guarded
// recordFailure / advanceFireAt. Mirrors fitness-api's push.d1.test.ts.
describe('D1 scheduled_notifications claim-before-send race', () => {
  let repos: Repos
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM push_subscriptions')
    await env.DB.exec('DELETE FROM scheduled_notifications')
    repos = buildD1Repos(createDb(env.DB))
  })

  const now = new Date('2026-06-17T12:00:00.000Z')
  const past = new Date('2026-06-17T11:00:00.000Z')
  const OK = () => ({ ok: true, statusCode: 201, expired: false })
  const FAIL = () => ({ ok: false, statusCode: 500, expired: false })

  async function subscribe(userId: string, n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      await repos.pushSubscriptions.upsert({
        idHash: `h_${userId}_${i}`,
        userId,
        endpoint: `https://push.example.com/${userId}/${i}`,
        p256dh: 'k',
        auth: 'a',
      })
    }
  }

  async function enqueueDue(id: string, userId = 'user_1', dedupeKey = 'event:e1') {
    await repos.scheduledNotifications.upsert(
      { id, userId, dedupeKey, source: 'event', title: 'A', body: null, url: 'https://x', fireAt: past },
      now,
    )
    const rows = await repos.scheduledNotifications.listDue(now, 10)
    return rows.find((r) => r.id === id)!
  }

  it('claim is atomic: two concurrent deliverers send exactly once', async () => {
    await subscribe('user_1', 1)
    const record = await enqueueDue('psn_a')
    const push = stubPush(OK)
    // Park the winner's send mid-flight so the loser's claim attempt runs while
    // the row is claimed but the send hasn't completed — the exact window the
    // old send-then-markSent code double-sent in.
    let release!: () => void
    push.gate.promise = new Promise((resolve) => {
      release = resolve
    })
    const a = deliverNotification(repos, push.service, record, now)
    const b = deliverNotification(repos, push.service, record, now)
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    const outcomes = (await Promise.all([a, b])).map((r) => r.outcome).sort()
    expect(outcomes).toEqual(['delivered', 'lost'])
    expect(push.sent).toHaveLength(1)
    expect(await repos.scheduledNotifications.listDue(now, 10)).toHaveLength(0)
  })

  it('a cancelled row cannot be claimed', async () => {
    await subscribe('user_1', 1)
    const record = await enqueueDue('psn_a')
    await repos.scheduledNotifications.cancel('user_1', 'event:e1', now)
    const push = stubPush(OK)
    // A deliverer holding a pre-cancel snapshot loses the claim outright.
    const result = await deliverNotification(repos, push.service, record, now)
    expect(result.outcome).toBe('lost')
    expect(push.sent).toHaveLength(0)
  })

  it('total send failure reverts the claim so the next pass retries', async () => {
    await subscribe('user_1', 1)
    const record = await enqueueDue('psn_a')
    const push = stubPush(FAIL)
    const r = await deliverNotification(repos, push.service, record, now)
    expect(r.outcome).toBe('failed')
    const due = await repos.scheduledNotifications.listDue(now, 10)
    expect(due).toHaveLength(1) // claim reverted, not stuck sent
    expect(due[0]!.attempts).toBe(1)
  })

  it('gives up after MAX_ATTEMPTS and keeps the row retired', async () => {
    await subscribe('user_1', 1)
    await enqueueDue('psn_a')
    const push = stubPush(FAIL)
    let last
    for (let i = 0; i < 5; i++) {
      const [record] = await repos.scheduledNotifications.listDue(now, 10)
      last = await deliverNotification(repos, push.service, record!, now)
    }
    expect(last!.outcome).toBe('gaveUp')
    // At the cap the claim is kept — the row stays retired, not looping forever.
    expect(await repos.scheduledNotifications.listDue(now, 10)).toHaveLength(0)
  })

  it('a reschedule that revives the row mid-send is not stomped by the stale failure', async () => {
    await subscribe('user_1', 1)
    const record = await enqueueDue('psn_a')
    const push = stubPush(FAIL)
    let release!: () => void
    push.gate.promise = new Promise((resolve) => {
      release = resolve
    })
    const delivery = deliverNotification(repos, push.service, record, now)
    // While the failing send is parked, the user edits the event — the upsert
    // revives the same row with a new deadline.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const newFireAt = new Date('2026-06-17T11:30:00.000Z')
    await repos.scheduledNotifications.upsert(
      { id: 'psn_b', userId: 'user_1', dedupeKey: 'event:e1', source: 'event', title: 'A', body: null, url: 'https://x', fireAt: newFireAt },
      now,
    )
    release()
    // The stale deliverer's failure write misses its claim guard: the revived
    // row keeps its fresh schedule instead of being reverted or retired.
    expect((await delivery).outcome).toBe('lost')
    const due = await repos.scheduledNotifications.listDue(now, 10)
    expect(due).toHaveLength(1)
    expect(due[0]!.attempts).toBe(0)
    expect(due[0]!.fireAt.toISOString()).toBe(newFireAt.toISOString())
  })

  it('advanceFireAt commits only for the caller that holds the claim', async () => {
    const fire = new Date('2026-06-18T09:00:00.000Z')
    const rule = JSON.stringify({ freq: 'daily', interval: 1, byDay: null, dtstart: '2026-06-01', until: null, count: null, timeOfDay: '09:00' })
    await repos.scheduledNotifications.upsert(
      { id: 'psn_c', userId: 'user_1', dedupeKey: 'series:s1', source: 'chore', title: 'Dishes', body: null, url: 'https://x', fireAt: fire, tz: 'UTC', recurrence: rule },
      now,
    )
    expect(await repos.scheduledNotifications.claimForSend('psn_c', now)).toBe(true)
    const next = new Date('2026-06-19T09:00:00.000Z')
    // A stale claim timestamp (or a revive) fails the guard — no advance.
    const wrong = await repos.scheduledNotifications.advanceFireAt(
      { id: 'psn_c', currentFireAt: fire, nextFireAt: next, claimedAt: new Date('2020-01-01T00:00:00.000Z') },
      now,
    )
    expect(wrong).toBe(false)
    // The real claim advances the row and re-arms it (sent_at cleared).
    const advanced = await repos.scheduledNotifications.advanceFireAt(
      { id: 'psn_c', currentFireAt: fire, nextFireAt: next, claimedAt: now },
      now,
    )
    expect(advanced).toBe(true)
    const due = await repos.scheduledNotifications.listDue(next, 10)
    expect(due).toHaveLength(1)
    expect(due[0]!.fireAt.toISOString()).toBe(next.toISOString())
    expect(due[0]!.attempts).toBe(0)
  })

  it('cron tick drains due rows, reaps dead endpoints, and retires no-device rows', async () => {
    await subscribe('user_1', 2) // endpoint /0 live, /1 dead
    await enqueueDue('psn_a', 'user_1', 'event:e1')
    await enqueueDue('psn_b', 'user_2', 'event:e2') // user_2 has no devices
    const push = stubPush((endpoint) =>
      endpoint.endsWith('/0')
        ? { ok: true, statusCode: 201, expired: false }
        : { ok: false, statusCode: 410, expired: true },
    )
    const result = await runNotificationTick(repos, push.service, now)
    expect(result.due).toBe(2)
    expect(result.delivered).toBe(1)
    expect(result.retired).toBe(1)
    expect(result.reapedSubscriptions).toBe(1)
    expect(await repos.pushSubscriptions.listByUser('user_1')).toHaveLength(1)
    expect(await repos.scheduledNotifications.listDue(now, 10)).toHaveLength(0)
  })
})
