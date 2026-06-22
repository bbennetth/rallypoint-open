import { materializeOccurrences, type RecurrenceRule } from '@rallypoint/lists-shared'
import type { Repos, ScheduledNotificationRecord } from '../repos/types.js'
import type { WebPushService } from '../services/types.js'
import { dayInstant } from './day-window.js'

// Pure decision + delivery logic for planner-owned push notifications.
// Kept free of Hono/D1 specifics so it can be unit-tested directly.

// Give up re-trying a notification after this many failed cron passes, so a
// persistently-erroring push endpoint can't keep a row live forever.
const MAX_ATTEMPTS = 5

export interface NotifiableEvent {
  id: string
  name: string
  // ISO-8601 instant (with offset) or null. A timed event carries a real
  // start instant; an all-day event sets allDay=true with a date-only instant.
  startAt: string | null
  allDay: boolean
}

export interface EventNotification {
  dedupeKey: string
  source: 'event'
  title: string
  body: string | null
  url: string
  fireAt: Date
}

// Decide whether a personal event should produce a notification, and when.
// Returns null for the "no notification" cases the feature requires:
//   - all-day events (day-only items never notify),
//   - events with no start instant,
//   - events whose start instant is in the past (nothing to schedule).
export function notificationForEvent(
  event: NotifiableEvent,
  opts: { now: Date; appUrl: string },
): EventNotification | null {
  if (event.allDay) return null
  if (!event.startAt) return null
  const fireAt = new Date(event.startAt)
  if (Number.isNaN(fireAt.getTime())) return null
  if (fireAt.getTime() <= opts.now.getTime()) return null
  return {
    dedupeKey: `event:${event.id}`,
    source: 'event',
    title: event.name.trim() || 'Upcoming event',
    body: 'Starting now',
    url: opts.appUrl,
    fireAt,
  }
}

// Enqueue (or, when the event is no longer notifiable — e.g. switched to
// all-day or moved into the past — cancel) the scheduled notification for a
// personal event. Idempotent: the queue upserts on (userId, dedupeKey).
export async function syncEventNotification(
  repos: Pick<Repos, 'scheduledNotifications'>,
  userId: string,
  event: NotifiableEvent,
  opts: { now: Date; appUrl: string; newId: () => string },
): Promise<void> {
  const notification = notificationForEvent(event, opts)
  if (!notification) {
    await repos.scheduledNotifications.cancel(userId, `event:${event.id}`, opts.now)
    return
  }
  await repos.scheduledNotifications.upsert(
    {
      id: opts.newId(),
      userId,
      dedupeKey: notification.dedupeKey,
      source: notification.source,
      title: notification.title,
      body: notification.body,
      url: notification.url,
      fireAt: notification.fireAt,
    },
    opts.now,
  )
}

export async function cancelEventNotification(
  repos: Pick<Repos, 'scheduledNotifications'>,
  userId: string,
  eventId: string,
  now: Date,
): Promise<void> {
  await repos.scheduledNotifications.cancel(userId, `event:${eventId}`, now)
}

// ── tasks ───────────────────────────────────────────────────────────
//
// Unlike personal events (which carry a true UTC start instant), a task's
// dueDate is NOT a true instant: the planner stores a date-only due at the
// user's LOCAL midnight, and a timed due as a real instant. So "does this task
// have a time?" can only be answered in the user's timezone — a due whose
// local clock reads 00:00 is day-only and must NOT notify. The client passes
// its IANA tz on the write so we can make that call here.

// Whether `instant` lands on 00:00 in `tz`. On an invalid/unknown tz we can't
// tell, so we report midnight → the caller declines to notify (safer than
// firing at the wrong moment).
function localClockIsMidnight(instant: Date, tz: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(instant)
    const hour = parts.find((p) => p.type === 'hour')?.value
    const minute = parts.find((p) => p.type === 'minute')?.value
    return hour === '00' && minute === '00'
  } catch {
    return true
  }
}

export interface NotifiableTask {
  id: string
  title: string
  dueDate: string | null
  // A recurring occurrence (non-null seriesId) is owned by the series, not the
  // item — skip it here so we don't double-schedule.
  seriesId: string | null
  completedAt: string | null
}

export interface TaskNotification {
  dedupeKey: string
  source: 'task'
  title: string
  body: string | null
  url: string
  fireAt: Date
}

// Decide whether a one-off task should notify, and when. Returns null for the
// "no notification" cases: recurring occurrences, completed tasks, no due, a
// day-only (local-midnight) due, or a due in the past.
export function notificationForTask(
  task: NotifiableTask,
  opts: { now: Date; tz: string; appUrl: string },
): TaskNotification | null {
  if (task.seriesId) return null
  if (task.completedAt) return null
  if (!task.dueDate) return null
  const fireAt = new Date(task.dueDate)
  if (Number.isNaN(fireAt.getTime())) return null
  if (localClockIsMidnight(fireAt, opts.tz)) return null
  if (fireAt.getTime() <= opts.now.getTime()) return null
  return {
    dedupeKey: `task:${task.id}`,
    source: 'task',
    title: task.title.trim() || 'Task',
    body: 'Due now',
    url: opts.appUrl,
    fireAt,
  }
}

export async function syncTaskNotification(
  repos: Pick<Repos, 'scheduledNotifications'>,
  userId: string,
  task: NotifiableTask,
  opts: { now: Date; tz: string; appUrl: string; newId: () => string },
): Promise<void> {
  const notification = notificationForTask(task, opts)
  if (!notification) {
    await repos.scheduledNotifications.cancel(userId, `task:${task.id}`, opts.now)
    return
  }
  await repos.scheduledNotifications.upsert(
    {
      id: opts.newId(),
      userId,
      dedupeKey: notification.dedupeKey,
      source: notification.source,
      title: notification.title,
      body: notification.body,
      url: notification.url,
      fireAt: notification.fireAt,
    },
    opts.now,
  )
}

export async function cancelTaskNotification(
  repos: Pick<Repos, 'scheduledNotifications'>,
  userId: string,
  taskId: string,
  now: Date,
): Promise<void> {
  await repos.scheduledNotifications.cancel(userId, `task:${taskId}`, now)
}

// ── chores (recurring) ──────────────────────────────────────────────
//
// A chore is a recurring series. We keep ONE pending row per series
// (dedupeKey `series:<id>`) = its next occurrence, and store the recurrence
// rule + tz on the row so the cron can advance it to the following occurrence
// after firing — entirely from the row, no SDK call. A chore notifies only
// when it carries a time-of-day; a day-only chore never notifies.

export interface NotifiableChoreSeries {
  id: string
  title: string
  freq: RecurrenceRule['freq']
  interval: number
  byDay: RecurrenceRule['byDay']
  dtstart: string
  until: string | null
  count: number | null
  timeOfDay: string | null
}

// The recurrence rule + time-of-day persisted on a chore notification row, so
// the cron can recompute the next occurrence with no external lookup.
interface StoredRecurrence {
  freq: RecurrenceRule['freq']
  interval: number
  byDay: RecurrenceRule['byDay']
  dtstart: string
  until: string | null
  count: number | null
  timeOfDay: string
}

// The local calendar date (YYYY-MM-DD) of `instant` in `tz`.
function ymdInTz(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

function ruleFromStored(s: { freq: RecurrenceRule['freq']; interval: number; byDay: RecurrenceRule['byDay']; dtstart: string; until: string | null; count: number | null }): RecurrenceRule {
  return {
    freq: s.freq,
    interval: s.interval,
    byDay: s.byDay ?? null,
    dtstart: s.dtstart,
    until: s.until,
    count: s.count,
  }
}

// The next occurrence's fire instant strictly after `after`, or null when the
// series has no further timed occurrence. Pure (no DB/SDK): the cron uses it to
// advance a series row. A small window (8) suffices because daily/weekly rules
// land their next hit within days.
export function nextOccurrenceInstant(
  rule: RecurrenceRule,
  timeOfDay: string,
  tz: string,
  after: Date,
): Date | null {
  let dates: string[]
  try {
    dates = materializeOccurrences(rule, { from: ymdInTz(after, tz), limit: 8 })
  } catch {
    return null
  }
  for (const ymd of dates) {
    let instant: Date
    try {
      instant = new Date(dayInstant(ymd, timeOfDay, tz))
    } catch {
      continue
    }
    if (!Number.isNaN(instant.getTime()) && instant.getTime() > after.getTime()) return instant
  }
  return null
}

export interface ChoreNotification {
  dedupeKey: string
  source: 'chore'
  title: string
  body: string | null
  url: string
  fireAt: Date
  tz: string
  recurrence: string
}

export function notificationForChoreSeries(
  series: NotifiableChoreSeries,
  opts: { now: Date; tz: string; appUrl: string },
): ChoreNotification | null {
  if (!series.timeOfDay) return null
  const rule = ruleFromStored(series)
  const fireAt = nextOccurrenceInstant(rule, series.timeOfDay, opts.tz, opts.now)
  if (!fireAt) return null
  const stored: StoredRecurrence = {
    freq: series.freq,
    interval: series.interval,
    byDay: series.byDay ?? null,
    dtstart: series.dtstart,
    until: series.until,
    count: series.count,
    timeOfDay: series.timeOfDay,
  }
  return {
    dedupeKey: `series:${series.id}`,
    source: 'chore',
    title: series.title.trim() || 'Chore',
    body: 'Due now',
    url: opts.appUrl,
    fireAt,
    tz: opts.tz,
    recurrence: JSON.stringify(stored),
  }
}

export async function syncChoreSeriesNotification(
  repos: Pick<Repos, 'scheduledNotifications'>,
  userId: string,
  series: NotifiableChoreSeries,
  opts: { now: Date; tz: string; appUrl: string; newId: () => string },
): Promise<void> {
  const notification = notificationForChoreSeries(series, opts)
  if (!notification) {
    await repos.scheduledNotifications.cancel(userId, `series:${series.id}`, opts.now)
    return
  }
  await repos.scheduledNotifications.upsert(
    {
      id: opts.newId(),
      userId,
      dedupeKey: notification.dedupeKey,
      source: notification.source,
      title: notification.title,
      body: notification.body,
      url: notification.url,
      fireAt: notification.fireAt,
      tz: notification.tz,
      recurrence: notification.recurrence,
    },
    opts.now,
  )
}

export async function cancelChoreSeriesNotification(
  repos: Pick<Repos, 'scheduledNotifications'>,
  userId: string,
  seriesId: string,
  now: Date,
): Promise<void> {
  await repos.scheduledNotifications.cancel(userId, `series:${seriesId}`, now)
}

// After a recurring row fires, compute its next occurrence (strictly after the
// instant that just fired). Returns null for a one-off row or an exhausted
// series.
function advanceRecurringFireAt(notification: ScheduledNotificationRecord): Date | null {
  if (!notification.recurrence || !notification.tz) return null
  let stored: StoredRecurrence
  try {
    stored = JSON.parse(notification.recurrence) as StoredRecurrence
  } catch {
    return null
  }
  if (!stored.timeOfDay) return null
  return nextOccurrenceInstant(
    ruleFromStored(stored),
    stored.timeOfDay,
    notification.tz,
    notification.fireAt,
  )
}

export interface NotificationTickResult {
  due: number
  delivered: number
  failed: number
  gaveUp: number
  // Rows retired without a delivery because the user had no live
  // subscriptions (none registered, or all were reaped this tick).
  retired: number
  // Recurring (chore) rows advanced to their next occurrence after firing.
  advanced: number
  reapedSubscriptions: number
}

// Drain due notifications and deliver them via Web Push. For each due row we
// fan out to every one of the user's subscriptions; a delivery to at least one
// device marks the row sent. Dead subscriptions (push service 404/410) are
// reaped. Transient failures bump the attempt counter and retry next pass,
// up to MAX_ATTEMPTS. Called from the Worker's `scheduled` cron handler.
export async function runNotificationTick(
  repos: Pick<Repos, 'scheduledNotifications' | 'pushSubscriptions'>,
  webPush: WebPushService,
  now: Date,
  opts?: { limit?: number },
): Promise<NotificationTickResult> {
  const limit = opts?.limit ?? 100
  const due = await repos.scheduledNotifications.listDue(now, limit)

  let delivered = 0
  let failed = 0
  let gaveUp = 0
  let retired = 0
  let advanced = 0
  let reapedSubscriptions = 0

  for (const notification of due) {
    const subscriptions = await repos.pushSubscriptions.listByUser(notification.userId)
    if (subscriptions.length === 0) {
      // No devices to deliver to — retire the row so it doesn't linger.
      await repos.scheduledNotifications.markSent(notification.id, now)
      retired++
      continue
    }

    const payload = JSON.stringify({
      title: notification.title,
      ...(notification.body ? { body: notification.body } : {}),
      url: notification.url,
    })

    let okCount = 0
    let transientErrors = 0
    for (const sub of subscriptions) {
      try {
        const result = await webPush.send(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        )
        if (result.ok) {
          okCount++
          await repos.pushSubscriptions.markSuccess(sub.idHash, now)
        } else if (result.expired) {
          await repos.pushSubscriptions.deleteByIdHash(sub.idHash)
          reapedSubscriptions++
        } else {
          transientErrors++
        }
      } catch {
        transientErrors++
      }
    }

    if (okCount > 0) {
      // A recurring (chore) row advances to its next occurrence instead of
      // retiring; a one-off (or exhausted) row is marked sent.
      const nextFireAt = advanceRecurringFireAt(notification)
      if (nextFireAt) {
        await repos.scheduledNotifications.upsert(
          {
            id: notification.id,
            userId: notification.userId,
            dedupeKey: notification.dedupeKey,
            source: notification.source,
            title: notification.title,
            body: notification.body,
            url: notification.url,
            fireAt: nextFireAt,
            tz: notification.tz,
            recurrence: notification.recurrence,
          },
          now,
        )
        advanced++
      } else {
        await repos.scheduledNotifications.markSent(notification.id, now)
      }
      delivered++
    } else if (transientErrors === 0) {
      // Every target was expired/reaped — nothing left to deliver to.
      await repos.scheduledNotifications.markSent(notification.id, now)
      retired++
    } else if (notification.attempts + 1 >= MAX_ATTEMPTS) {
      await repos.scheduledNotifications.markSent(notification.id, now)
      gaveUp++
    } else {
      await repos.scheduledNotifications.recordFailure(notification.id, 'no successful delivery', now)
      failed++
    }
  }

  return { due: due.length, delivered, failed, gaveUp, retired, advanced, reapedSubscriptions }
}

// ── direct delivery (test notification) ─────────────────────────────

export interface DeliveryResult {
  // Subscriptions the user has registered.
  subscriptions: number
  // Subscriptions that accepted the push.
  sent: number
  // Dead subscriptions (404/410) reaped during the send.
  reaped: number
}

// Send a payload to every one of a user's registered subscriptions right now
// (bypassing the scheduled queue) — backs the Settings "send a test
// notification" action. Dead subscriptions are reaped, like the cron does.
export async function deliverToUser(
  repos: Pick<Repos, 'pushSubscriptions'>,
  webPush: WebPushService,
  userId: string,
  payload: string,
  now: Date,
): Promise<DeliveryResult> {
  const subscriptions = await repos.pushSubscriptions.listByUser(userId)
  let sent = 0
  let reaped = 0
  for (const sub of subscriptions) {
    try {
      const result = await webPush.send(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      )
      if (result.ok) {
        sent++
        await repos.pushSubscriptions.markSuccess(sub.idHash, now)
      } else if (result.expired) {
        await repos.pushSubscriptions.deleteByIdHash(sub.idHash)
        reaped++
      }
    } catch {
      // Transient transport error — leave the subscription in place.
    }
  }
  return { subscriptions: subscriptions.length, sent, reaped }
}
