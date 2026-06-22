import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { buildD1Repos, createDb } from './index.js'
import type { Repos } from '../types.js'

// Real workerd + Miniflare D1 (run: `npm run test:d1:planner`). Exercises the
// two notification infra tables against the actual migration-applied schema.

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

  it('recordFailure increments attempts', async () => {
    const now = new Date('2026-06-17T12:00:00.000Z')
    const past = new Date('2026-06-17T11:00:00.000Z')
    await repos.scheduledNotifications.upsert(
      { id: 'psn_1', userId: 'user_1', dedupeKey: 'event:e1', source: 'event', title: 'A', body: null, url: 'https://x', fireAt: past },
      now,
    )
    await repos.scheduledNotifications.recordFailure('psn_1', 'boom', now)
    const due = await repos.scheduledNotifications.listDue(now, 10)
    expect(due[0]!.attempts).toBe(1)
    expect(due[0]!.lastError).toBe('boom')
  })
})
