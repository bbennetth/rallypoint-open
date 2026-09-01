import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { buildD1Repos, createDb } from './index.js'
import type { Repos } from '../types.js'
import {
  deliverNotification,
  deliverNotificationById,
  REST_PUSH_GRACE_MS,
  notificationTopic,
  runNotificationTick,
} from '../../lib/notifications.js'
import type { WebPushService } from '../../services/types.js'

// Real workerd + Miniflare D1 (run: `npm run test:d1:fitness`). Exercises
// the rest-timer push infra tables + the shared delivery logic against
// the actual migration-applied schema. Web Push sends are stubbed — the
// D1 state transitions (claim/sent/cancelled/attempts/reap) are what's
// under test, not RFC 8291 crypto (covered in packages/web-push).

function stubPush(
  behavior: (endpoint: string) => { ok: boolean; statusCode: number; expired: boolean },
): {
  service: WebPushService
  sent: string[]
  payloads: string[]
  sendOpts: ({ topic?: string } | undefined)[]
  /** When set, every send awaits this before returning (park mid-flight). */
  gate: { promise: Promise<void> | null }
} {
  const sent: string[] = []
  const payloads: string[] = []
  const sendOpts: ({ topic?: string } | undefined)[] = []
  const gate: { promise: Promise<void> | null } = { promise: null }
  return {
    sent,
    payloads,
    sendOpts,
    gate,
    service: {
      async send(sub, payload, opts) {
        sent.push(sub.endpoint)
        payloads.push(payload)
        sendOpts.push(opts)
        if (gate.promise) await gate.promise
        return behavior(sub.endpoint)
      },
    },
  }
}

const OK = () => ({ ok: true, statusCode: 201, expired: false })

describe('D1 rest-timer push queue', () => {
  let repos: Repos
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM push_subscriptions')
    await env.DB.exec('DELETE FROM scheduled_notifications')
    repos = buildD1Repos(createDb(env.DB))
  })

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

  function restRow(overrides?: Partial<Parameters<Repos['scheduledNotifications']['upsert']>[0]>) {
    return {
      id: `fntf_${Math.random().toString(36).slice(2)}`,
      userId: 'user_1',
      dedupeKey: 'rest:ses_1',
      source: 'rest',
      title: 'Rest done',
      body: 'Back to work.',
      url: 'https://health.rallypt.dev/live/strength/new',
      fireAt: new Date('2026-07-16T10:00:00.000Z'),
      ...overrides,
    }
  }

  it('upsert dedupes on (user, dedupeKey), revives cancelled rows, and returns the surviving id', async () => {
    const now = new Date('2026-07-16T09:58:00.000Z')
    const firstId = await repos.scheduledNotifications.upsert(restRow({ id: 'fntf_a' }), now)
    expect(firstId).toBe('fntf_a')
    await repos.scheduledNotifications.cancel('user_1', 'rest:ses_1', now)
    // Re-schedule (adjusted timer): same dedupe key, new fireAt/id.
    const survivedId = await repos.scheduledNotifications.upsert(
      restRow({ id: 'fntf_b', fireAt: new Date('2026-07-16T10:01:00.000Z') }),
      now,
    )
    expect(survivedId).toBe('fntf_a') // conflict keeps the original row id
    const row = await repos.scheduledNotifications.getById('fntf_a')
    expect(row?.cancelledAt).toBeNull()
    expect(row?.fireAt.toISOString()).toBe('2026-07-16T10:01:00.000Z')
    const due = await repos.scheduledNotifications.listDue(
      new Date('2026-07-16T10:02:00.000Z'),
      10,
    )
    expect(due).toHaveLength(1)
  })

  it('cancelled and sent rows are not due', async () => {
    const now = new Date('2026-07-16T09:58:00.000Z')
    await repos.scheduledNotifications.upsert(restRow({ id: 'fntf_a' }), now)
    await repos.scheduledNotifications.upsert(
      restRow({ id: 'fntf_b', dedupeKey: 'rest:ses_2' }),
      now,
    )
    await repos.scheduledNotifications.cancel('user_1', 'rest:ses_1', now)
    await repos.scheduledNotifications.markSent('fntf_b', now)
    const due = await repos.scheduledNotifications.listDue(
      new Date('2026-07-16T10:05:00.000Z'),
      10,
    )
    expect(due).toHaveLength(0)
  })

  it('deliverNotificationById delivers a pending row once and no-ops after', async () => {
    await subscribe('user_1', 2)
    const now = new Date('2026-07-16T10:00:01.000Z')
    const id = await repos.scheduledNotifications.upsert(restRow({ id: 'fntf_a' }), now)
    const push = stubPush(OK)
    const record = await repos.scheduledNotifications.getById(id)
    const first = await deliverNotificationById(repos, push.service, id, now)
    expect(first?.outcome).toBe('delivered')
    expect(push.sent).toHaveLength(2) // fan-out to both devices
    // Every send carries the RFC 8030 collapse topic for this dedupe key.
    const topic = notificationTopic('rest:ses_1')
    expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(push.sendOpts.map((o) => o?.topic)).toEqual([topic, topic])
    // The payload carries the OS tag plus the raw client deadline
    // (fire_at minus the backstop grace) — the SW's same-rest-period
    // dedupe keys off deadlineMs.
    const payload = JSON.parse(push.payloads[0]) as { tag?: string; deadlineMs?: number }
    expect(payload.tag).toBe('rest:ses_1')
    expect(payload.deadlineMs).toBe(record!.fireAt.getTime() - REST_PUSH_GRACE_MS)
    // The alarm racing the cron: second call sees sentAt and no-ops.
    const second = await deliverNotificationById(repos, push.service, id, now)
    expect(second).toBeNull()
    expect(push.sent).toHaveLength(2)
    // A deliverer holding a stale pre-send snapshot of the record loses
    // the claim outright — no pre-check needed to stay single-send.
    const stale = await deliverNotification(repos, push.service, record!, now)
    expect(stale.outcome).toBe('lost')
    expect(push.sent).toHaveLength(2)
  })

  it('claim is atomic: two concurrent deliverers send exactly once', async () => {
    await subscribe('user_1', 1)
    const now = new Date('2026-07-16T10:00:01.000Z')
    const id = await repos.scheduledNotifications.upsert(restRow({ id: 'fntf_a' }), now)
    const record = await repos.scheduledNotifications.getById(id)
    const push = stubPush(OK)
    // Park the winner's send mid-flight so the loser's claim attempt runs
    // while the row is claimed but the send hasn't completed — the exact
    // window where the old send-then-markSent code double-sent.
    let release!: () => void
    push.gate.promise = new Promise((resolve) => {
      release = resolve
    })
    const a = deliverNotification(repos, push.service, record!, now)
    const b = deliverNotification(repos, push.service, record!, now)
    // Let both claims land before releasing the parked send.
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    const outcomes = (await Promise.all([a, b])).map((r) => r.outcome).sort()
    expect(outcomes).toEqual(['delivered', 'lost'])
    expect(push.sent).toHaveLength(1)
  })

  it('a cancelled row cannot be claimed', async () => {
    await subscribe('user_1', 1)
    const now = new Date('2026-07-16T10:00:01.000Z')
    const id = await repos.scheduledNotifications.upsert(restRow({ id: 'fntf_a' }), now)
    const record = await repos.scheduledNotifications.getById(id)
    await repos.scheduledNotifications.cancel('user_1', 'rest:ses_1', now)
    const push = stubPush(OK)
    // A deliverer holding a pre-cancel snapshot (the DO alarm racing a
    // skip) loses the claim and sends nothing.
    const result = await deliverNotification(repos, push.service, record!, now)
    expect(result.outcome).toBe('lost')
    expect(push.sent).toHaveLength(0)
  })

  it('a reschedule that revives the row mid-send is not stomped by the stale failure', async () => {
    await subscribe('user_1', 1)
    const now = new Date('2026-07-16T10:00:30.000Z')
    const id = await repos.scheduledNotifications.upsert(restRow({ id: 'fntf_a' }), now)
    const push = stubPush(() => ({ ok: false, statusCode: 500, expired: false }))
    let release!: () => void
    push.gate.promise = new Promise((resolve) => {
      release = resolve
    })
    const delivery = deliverNotificationById(repos, push.service, id, now)
    // While the (failing) send is parked in flight, the user adjusts the
    // rest timer — the upsert revives the same row with a new deadline.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const newFireAt = new Date('2026-07-16T10:03:00.000Z')
    await repos.scheduledNotifications.upsert(restRow({ id: 'fntf_b', fireAt: newFireAt }), now)
    release()
    // The stale deliverer's failure write misses its claim guard: the
    // revived row keeps its fresh schedule instead of being reverted or
    // retired (the old bug silently ate the rescheduled notification).
    expect((await delivery)?.outcome).toBe('lost')
    const row = await repos.scheduledNotifications.getById(id)
    expect(row?.sentAt).toBeNull()
    expect(row?.attempts).toBe(0)
    expect(row?.fireAt.toISOString()).toBe(newFireAt.toISOString())
  })

  it('total send failure reverts the claim so the next pass retries', async () => {
    await subscribe('user_1', 1)
    const now = new Date('2026-07-16T10:00:30.000Z')
    const id = await repos.scheduledNotifications.upsert(restRow({ id: 'fntf_a' }), now)
    const push = stubPush(() => ({ ok: false, statusCode: 500, expired: false }))
    const r = await deliverNotificationById(repos, push.service, id, now)
    expect(r?.outcome).toBe('failed')
    const row = await repos.scheduledNotifications.getById(id)
    expect(row?.sentAt).toBeNull() // claim reverted, not stuck sent
    expect(row?.attempts).toBe(1)
    expect(await repos.scheduledNotifications.listDue(now, 10)).toHaveLength(1)
  })

  it('cron tick drains due rows, reaps dead endpoints, and retires rows with no devices', async () => {
    const now = new Date('2026-07-16T10:00:30.000Z')
    // user_1: one live + one dead endpoint; user_2: no devices at all.
    await subscribe('user_1', 2)
    await repos.scheduledNotifications.upsert(restRow({ id: 'fntf_a' }), now)
    await repos.scheduledNotifications.upsert(
      restRow({ id: 'fntf_b', userId: 'user_2', dedupeKey: 'rest:ses_9' }),
      now,
    )
    const push = stubPush((endpoint) =>
      endpoint.endsWith('/0')
        ? { ok: true, statusCode: 201, expired: false }
        : { ok: false, statusCode: 410, expired: true },
    )
    const result = await runNotificationTick(repos, push.service, now)
    expect(result.due).toBe(2)
    expect(result.delivered).toBe(1)
    expect(result.retired).toBe(1) // user_2 had no devices
    expect(result.reapedSubscriptions).toBe(1)
    expect(await repos.pushSubscriptions.listByUser('user_1')).toHaveLength(1)
    // Nothing left due.
    expect(await repos.scheduledNotifications.listDue(now, 10)).toHaveLength(0)
  })

  it('transient failures bump attempts and give up after the cap', async () => {
    await subscribe('user_1', 1)
    const now = new Date('2026-07-16T10:00:30.000Z')
    const id = await repos.scheduledNotifications.upsert(restRow({ id: 'fntf_a' }), now)
    const push = stubPush(() => ({ ok: false, statusCode: 500, expired: false }))
    for (let i = 1; i <= 4; i++) {
      const r = await deliverNotificationById(repos, push.service, id, now)
      expect(r?.outcome).toBe('failed')
    }
    const final = await deliverNotificationById(repos, push.service, id, now)
    expect(final?.outcome).toBe('gaveUp')
    // Row is retired (markSent) so the queue can't loop on it forever.
    expect(await repos.scheduledNotifications.listDue(now, 10)).toHaveLength(0)
  })
})
