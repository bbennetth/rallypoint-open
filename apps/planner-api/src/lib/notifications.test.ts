import { describe, it, expect } from 'vitest'
import type { SendPushResult, WebPushSubscription } from '@rallypoint/web-push'
import { buildMemoryRepos } from '../repos/memory.js'
import type { WebPushService } from '../services/types.js'
import {
  cancelEventNotification,
  deliverToUser,
  notificationForChoreSeries,
  notificationForEvent,
  notificationForTask,
  runNotificationTick,
  syncChoreSeriesNotification,
  syncEventNotification,
  syncTaskNotification,
  type NotifiableChoreSeries,
} from './notifications.js'

const APP_URL = 'https://planner.rallypt.dev'
const NOW = new Date('2026-06-17T12:00:00.000Z')
const FUTURE = '2026-06-17T18:30:00.000Z'
const PAST = '2026-06-17T06:00:00.000Z'

function fakeWebPush(
  handler: (sub: WebPushSubscription, payload: string) => SendPushResult | Promise<SendPushResult>,
): WebPushService & { calls: Array<{ endpoint: string; payload: string }> } {
  const calls: Array<{ endpoint: string; payload: string }> = []
  return {
    calls,
    async send(sub, payload) {
      calls.push({ endpoint: sub.endpoint, payload })
      return handler(sub, payload)
    },
  }
}

function ok(): SendPushResult {
  return { ok: true, statusCode: 201, expired: false }
}
function expired(): SendPushResult {
  return { ok: false, statusCode: 410, expired: true }
}
function transient(): SendPushResult {
  return { ok: false, statusCode: 500, expired: false }
}

async function seedSubscription(repos: ReturnType<typeof buildMemoryRepos>, userId: string, idHash = 'sub1') {
  await repos.pushSubscriptions.upsert({
    idHash,
    userId,
    endpoint: `https://push.example.com/${idHash}`,
    p256dh: 'p256dh-key',
    auth: 'auth-secret',
  })
}

describe('notificationForEvent', () => {
  it('schedules a timed future event at its start instant', () => {
    const n = notificationForEvent(
      { id: 'event_1', name: 'Dentist', startAt: FUTURE, allDay: false },
      { now: NOW, appUrl: APP_URL },
    )
    expect(n).not.toBeNull()
    expect(n!.dedupeKey).toBe('event:event_1')
    expect(n!.fireAt.toISOString()).toBe(FUTURE)
    expect(n!.title).toBe('Dentist')
    expect(n!.url).toBe(APP_URL)
  })

  it('returns null for an all-day event (day-only items never notify)', () => {
    expect(
      notificationForEvent(
        { id: 'event_1', name: 'Holiday', startAt: FUTURE, allDay: true },
        { now: NOW, appUrl: APP_URL },
      ),
    ).toBeNull()
  })

  it('returns null when there is no start instant', () => {
    expect(
      notificationForEvent(
        { id: 'event_1', name: 'Someday', startAt: null, allDay: false },
        { now: NOW, appUrl: APP_URL },
      ),
    ).toBeNull()
  })

  it('returns null for a start instant in the past', () => {
    expect(
      notificationForEvent(
        { id: 'event_1', name: 'Earlier', startAt: PAST, allDay: false },
        { now: NOW, appUrl: APP_URL },
      ),
    ).toBeNull()
  })

  it('falls back to a generic title when the name is blank', () => {
    const n = notificationForEvent(
      { id: 'event_1', name: '   ', startAt: FUTURE, allDay: false },
      { now: NOW, appUrl: APP_URL },
    )
    expect(n!.title).toBe('Upcoming event')
  })
})

describe('syncEventNotification', () => {
  const opts = { now: NOW, appUrl: APP_URL, newId: () => 'psn_test' }

  it('enqueues a timed event so the cron later finds it due', async () => {
    const repos = buildMemoryRepos()
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: FUTURE, allDay: false }, opts)
    const due = await repos.scheduledNotifications.listDue(new Date(FUTURE), 10)
    expect(due).toHaveLength(1)
    expect(due[0]!.dedupeKey).toBe('event:event_1')
  })

  it('cancels the pending notification when an event becomes all-day', async () => {
    const repos = buildMemoryRepos()
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: FUTURE, allDay: false }, opts)
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: FUTURE, allDay: true }, opts)
    const due = await repos.scheduledNotifications.listDue(new Date(FUTURE), 10)
    expect(due).toHaveLength(0)
  })

  it('reschedules to the new instant on edit', async () => {
    const repos = buildMemoryRepos()
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: FUTURE, allDay: false }, opts)
    const later = '2026-06-18T09:00:00.000Z'
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: later, allDay: false }, opts)
    const due = await repos.scheduledNotifications.listDue(new Date(later), 10)
    expect(due).toHaveLength(1)
    expect(due[0]!.fireAt.toISOString()).toBe(later)
  })

  it('cancelEventNotification removes a pending notification', async () => {
    const repos = buildMemoryRepos()
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: FUTURE, allDay: false }, opts)
    await cancelEventNotification(repos, 'user_a', 'event_1', NOW)
    const due = await repos.scheduledNotifications.listDue(new Date(FUTURE), 10)
    expect(due).toHaveLength(0)
  })
})

describe('notificationForTask', () => {
  const base = { now: NOW, appUrl: APP_URL }

  it('schedules a timed task at its due instant', () => {
    const n = notificationForTask(
      { id: 'lit_1', title: 'Call bank', dueDate: FUTURE, seriesId: null, completedAt: null },
      { ...base, tz: 'UTC' },
    )
    expect(n).not.toBeNull()
    expect(n!.dedupeKey).toBe('task:lit_1')
    expect(n!.fireAt.toISOString()).toBe(FUTURE)
    expect(n!.source).toBe('task')
  })

  it('returns null for a date-only (local-midnight) due in the user’s zone', () => {
    // 04:00Z on 6/18 is 00:00 in America/New_York (EDT) — a date-only due.
    expect(
      notificationForTask(
        { id: 'lit_1', title: 'x', dueDate: '2026-06-18T04:00:00.000Z', seriesId: null, completedAt: null },
        { ...base, tz: 'America/New_York' },
      ),
    ).toBeNull()
    // ...but the SAME instant is 04:00 (timed) for a UTC user.
    expect(
      notificationForTask(
        { id: 'lit_1', title: 'x', dueDate: '2026-06-18T04:00:00.000Z', seriesId: null, completedAt: null },
        { ...base, tz: 'UTC' },
      ),
    ).not.toBeNull()
  })

  it('returns null for recurring occurrences, completed, missing, past, and bad tz', () => {
    const ok = { id: 'lit_1', title: 'x', dueDate: FUTURE, seriesId: null, completedAt: null }
    expect(notificationForTask({ ...ok, seriesId: 'lse_1' }, { ...base, tz: 'UTC' })).toBeNull()
    expect(notificationForTask({ ...ok, completedAt: '2026-06-17T11:00:00Z' }, { ...base, tz: 'UTC' })).toBeNull()
    expect(notificationForTask({ ...ok, dueDate: null }, { ...base, tz: 'UTC' })).toBeNull()
    expect(notificationForTask({ ...ok, dueDate: 'not-a-date' }, { ...base, tz: 'UTC' })).toBeNull()
    expect(notificationForTask({ ...ok, dueDate: PAST }, { ...base, tz: 'UTC' })).toBeNull()
    expect(notificationForTask(ok, { ...base, tz: 'Not/AZone' })).toBeNull()
  })
})

describe('syncTaskNotification', () => {
  const opts = { now: NOW, appUrl: APP_URL, newId: () => 'psn_task', tz: 'UTC' }

  it('enqueues a timed task and cancels when it becomes date-only or completed', async () => {
    const repos = buildMemoryRepos()
    const task = { id: 'lit_1', title: 'Call', dueDate: FUTURE, seriesId: null, completedAt: null }
    await syncTaskNotification(repos, 'user_a', task, opts)
    expect(await repos.scheduledNotifications.listDue(new Date(FUTURE), 10)).toHaveLength(1)

    await syncTaskNotification(repos, 'user_a', { ...task, completedAt: '2026-06-17T19:00:00Z' }, opts)
    expect(await repos.scheduledNotifications.listDue(new Date(FUTURE), 10)).toHaveLength(0)
  })
})

describe('notificationForChoreSeries', () => {
  const dailyAt9: NotifiableChoreSeries = {
    id: 'lse_1',
    title: 'Dishes',
    freq: 'daily',
    interval: 1,
    byDay: null,
    dtstart: '2026-06-01',
    until: null,
    count: null,
    timeOfDay: '09:00',
  }
  const opts = { now: NOW, tz: 'UTC', appUrl: APP_URL }

  it('schedules the next occurrence of a timed chore (today’s already passed)', () => {
    const n = notificationForChoreSeries(dailyAt9, opts)
    expect(n).not.toBeNull()
    expect(n!.dedupeKey).toBe('series:lse_1')
    expect(n!.source).toBe('chore')
    expect(n!.tz).toBe('UTC')
    // NOW = 2026-06-17T12:00Z → today's 09:00 passed → next is 6/18 09:00Z.
    expect(n!.fireAt.toISOString()).toBe('2026-06-18T09:00:00.000Z')
    expect(JSON.parse(n!.recurrence).timeOfDay).toBe('09:00')
  })

  it('returns null for a day-only chore (no time-of-day)', () => {
    expect(notificationForChoreSeries({ ...dailyAt9, timeOfDay: null }, opts)).toBeNull()
  })

  it('returns null when the series has already ended', () => {
    expect(notificationForChoreSeries({ ...dailyAt9, until: '2026-06-10' }, opts)).toBeNull()
  })
})

describe('runNotificationTick', () => {
  const enqueue = { now: NOW, appUrl: APP_URL, newId: () => 'psn_test' }
  const drainAt = new Date(FUTURE)

  it('delivers a due notification and marks it sent', async () => {
    const repos = buildMemoryRepos()
    await seedSubscription(repos, 'user_a')
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: FUTURE, allDay: false }, enqueue)
    const webPush = fakeWebPush(ok)

    const result = await runNotificationTick(repos, webPush, drainAt)

    expect(result).toMatchObject({ due: 1, delivered: 1, failed: 0 })
    expect(webPush.calls).toHaveLength(1)
    expect(JSON.parse(webPush.calls[0]!.payload)).toMatchObject({ title: 'Run', url: APP_URL })
    // No longer due once sent.
    expect(await repos.scheduledNotifications.listDue(drainAt, 10)).toHaveLength(0)
  })

  it('reaps an expired subscription and retires the notification', async () => {
    const repos = buildMemoryRepos()
    await seedSubscription(repos, 'user_a')
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: FUTURE, allDay: false }, enqueue)

    const result = await runNotificationTick(repos, fakeWebPush(expired), drainAt)

    expect(result.reapedSubscriptions).toBe(1)
    expect(result.retired).toBe(1)
    expect(await repos.pushSubscriptions.listByUser('user_a')).toHaveLength(0)
    // Nothing left to deliver to -> retired (not retried forever).
    expect(await repos.scheduledNotifications.listDue(drainAt, 10)).toHaveLength(0)
  })

  it('retries on a transient failure (stays due, attempts bump)', async () => {
    const repos = buildMemoryRepos()
    await seedSubscription(repos, 'user_a')
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: FUTURE, allDay: false }, enqueue)

    const result = await runNotificationTick(repos, fakeWebPush(transient), drainAt)

    expect(result).toMatchObject({ delivered: 0, failed: 1 })
    const stillDue = await repos.scheduledNotifications.listDue(drainAt, 10)
    expect(stillDue).toHaveLength(1)
    expect(stillDue[0]!.attempts).toBe(1)
  })

  it('gives up after MAX_ATTEMPTS of transient failures', async () => {
    const repos = buildMemoryRepos()
    await seedSubscription(repos, 'user_a')
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: FUTURE, allDay: false }, enqueue)

    let last
    for (let i = 0; i < 5; i++) {
      last = await runNotificationTick(repos, fakeWebPush(transient), drainAt)
    }
    expect(last!.gaveUp).toBe(1)
    expect(await repos.scheduledNotifications.listDue(drainAt, 10)).toHaveLength(0)
  })

  it('advances a recurring chore to its next occurrence after firing', async () => {
    const repos = buildMemoryRepos()
    await seedSubscription(repos, 'user_a')
    const series: NotifiableChoreSeries = {
      id: 'lse_1', title: 'Dishes', freq: 'daily', interval: 1, byDay: null,
      dtstart: '2026-06-01', until: null, count: null, timeOfDay: '09:00',
    }
    await syncChoreSeriesNotification(repos, 'user_a', series, {
      now: NOW, tz: 'UTC', appUrl: APP_URL, newId: () => 'psn_c',
    })
    // First occurrence after NOW is 2026-06-18T09:00Z.
    const firstFire = new Date('2026-06-18T09:00:00.000Z')
    const result = await runNotificationTick(repos, fakeWebPush(ok), firstFire)

    expect(result).toMatchObject({ delivered: 1, advanced: 1 })
    // No longer due at firstFire; the single row advanced to the next day.
    expect(await repos.scheduledNotifications.listDue(firstFire, 10)).toHaveLength(0)
    const next = await repos.scheduledNotifications.listDue(new Date('2026-06-19T09:00:00.000Z'), 10)
    expect(next).toHaveLength(1)
    expect(next[0]!.fireAt.toISOString()).toBe('2026-06-19T09:00:00.000Z')
  })

  it('retires (does not crash on) a recurring row with corrupt recurrence JSON', async () => {
    const repos = buildMemoryRepos()
    await seedSubscription(repos, 'user_a')
    await repos.scheduledNotifications.upsert(
      { id: 'psn_x', userId: 'user_a', dedupeKey: 'series:bad', source: 'chore', title: 'X', body: null, url: APP_URL, fireAt: new Date('2026-06-17T09:00:00.000Z'), tz: 'UTC', recurrence: 'not-json' },
      NOW,
    )
    const result = await runNotificationTick(repos, fakeWebPush(ok), NOW)
    expect(result).toMatchObject({ delivered: 1, advanced: 0 })
    expect(await repos.scheduledNotifications.listDue(NOW, 10)).toHaveLength(0)
  })

  it('retires a recurring row whose series is exhausted', async () => {
    const repos = buildMemoryRepos()
    await seedSubscription(repos, 'user_a')
    const ended = JSON.stringify({ freq: 'daily', interval: 1, byDay: null, dtstart: '2020-01-01', until: '2020-01-02', count: null, timeOfDay: '09:00' })
    await repos.scheduledNotifications.upsert(
      { id: 'psn_y', userId: 'user_a', dedupeKey: 'series:ended', source: 'chore', title: 'Y', body: null, url: APP_URL, fireAt: new Date('2026-06-17T09:00:00.000Z'), tz: 'UTC', recurrence: ended },
      NOW,
    )
    const result = await runNotificationTick(repos, fakeWebPush(ok), NOW)
    expect(result).toMatchObject({ delivered: 1, advanced: 0 })
    expect(await repos.scheduledNotifications.listDue(NOW, 10)).toHaveLength(0)
  })

  it('retires a due notification when the user has no subscriptions', async () => {
    const repos = buildMemoryRepos()
    await syncEventNotification(repos, 'user_a', { id: 'event_1', name: 'Run', startAt: FUTURE, allDay: false }, enqueue)
    const webPush = fakeWebPush(ok)

    const result = await runNotificationTick(repos, webPush, drainAt)

    expect(webPush.calls).toHaveLength(0)
    expect(result.due).toBe(1)
    expect(result.retired).toBe(1)
    expect(await repos.scheduledNotifications.listDue(drainAt, 10)).toHaveLength(0)
  })
})

describe('deliverToUser (test notification)', () => {
  const now = new Date('2026-06-17T12:00:00.000Z')

  it('sends to every registered device and reports the count', async () => {
    const repos = buildMemoryRepos()
    await seedSubscription(repos, 'user_a', 'sub1')
    await seedSubscription(repos, 'user_a', 'sub2')
    const webPush = fakeWebPush(ok)

    const result = await deliverToUser(repos, webPush, 'user_a', '{"title":"hi"}', now)

    expect(result).toEqual({ subscriptions: 2, sent: 2, reaped: 0 })
    expect(webPush.calls).toHaveLength(2)
    const subs = await repos.pushSubscriptions.listByUser('user_a')
    expect(subs.every((s) => s.lastSuccessAt !== null)).toBe(true)
  })

  it('reaps a dead device and counts it', async () => {
    const repos = buildMemoryRepos()
    await seedSubscription(repos, 'user_a', 'sub1')
    const result = await deliverToUser(repos, fakeWebPush(expired), 'user_a', '{}', now)
    expect(result).toEqual({ subscriptions: 1, sent: 0, reaped: 1 })
    expect(await repos.pushSubscriptions.listByUser('user_a')).toHaveLength(0)
  })

  it('leaves a device in place on a transient (non-expired) failure', async () => {
    const repos = buildMemoryRepos()
    await seedSubscription(repos, 'user_a', 'sub1')
    const result = await deliverToUser(repos, fakeWebPush(transient), 'user_a', '{}', now)
    expect(result).toEqual({ subscriptions: 1, sent: 0, reaped: 0 })
    expect(await repos.pushSubscriptions.listByUser('user_a')).toHaveLength(1)
  })

  it('reports zero when the user has no devices', async () => {
    const repos = buildMemoryRepos()
    const webPush = fakeWebPush(ok)
    const result = await deliverToUser(repos, webPush, 'user_a', '{}', now)
    expect(result).toEqual({ subscriptions: 0, sent: 0, reaped: 0 })
    expect(webPush.calls).toHaveLength(0)
  })
})
