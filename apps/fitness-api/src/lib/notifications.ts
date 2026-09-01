import { hashToken } from '@rallypoint/crypto'
import type {
  Repos,
  ScheduledNotificationRecord,
} from '../repos/types.js'
import type { WebPushService } from '../services/types.js'

// Delivery logic for fitness-owned push notifications (rest timers).
// Mirrors planner-api's lib/notifications.ts drain, minus recurrence —
// rest-timer rows are one-off. Two callers share deliverNotification():
// the RestTimerAlarm DO (on-time delivery at fireAt) and the per-minute
// cron sweep (safety net for missed alarms). Delivery is serialized by an
// atomic sent_at CAS (claimForSend) BEFORE any send goes out, so an alarm
// racing a cron tick — or a re-firing at-least-once DO alarm — sends at
// most once; the loser gets outcome 'lost'. The OS-level notification tag
// and the push-service Topic header are defense-in-depth only.

// Give up re-trying a notification after this many failed passes so a
// persistently-erroring endpoint can't keep a row live forever.
const MAX_ATTEMPTS = 5

// Rest timers are short; refuse to schedule anything absurdly far out so
// the queue can't be used as a general reminder store (and a client-clock
// bug can't park rows in 299).
export const REST_MAX_LEAD_MS = 30 * 60 * 1000

// The backstop push fires this long AFTER the client's rest deadline. A
// live tab delivers the alert locally at the deadline and then disarms
// the backstop; scheduling the server push at exactly the same instant
// made the disarm race the DO alarm (and lose once claimForSend ran),
// so the same rest period doubled: one local banner + one push. The
// grace window lets the disarm win whenever the tab is alive; a
// suspended/killed tab still gets the push, just slightly late. 20s
// comfortably covers a throttled background tab firing its timeout a
// few seconds late plus the disarm's network round-trip, while keeping
// the backstop timely for a dead tab. Note the disarm cancels the row
// server-wide: with the grace window a live tab's local alert now
// reliably (not coin-flip) suppresses the backstop on the user's OTHER
// devices too — the intended behavior for a rest timer.
export const REST_PUSH_GRACE_MS = 20_000

/** The queue dedupe key for a rest-timer tag (one pending rest
 *  notification per live session). */
export function restDedupeKey(tag: string): string {
  return `rest:${tag}`
}

export interface DeliverResult {
  outcome: 'delivered' | 'retired' | 'failed' | 'gaveUp' | 'lost'
  reapedSubscriptions: number
}

/** RFC 8030 Topic (collapse key) for a notification: newer pending
 *  messages with the same topic replace older ones at the push service,
 *  so a duplicate send can't stack up for an offline device. Raw dedupe
 *  keys (`rest:<sessionId>`) violate the Topic charset/length rules, so
 *  hash to 32 hex chars (hex ⊂ base64url, exactly the max length). */
export function notificationTopic(dedupeKey: string): string {
  return hashToken(dedupeKey).slice(0, 32)
}

// Deliver one pending notification to every one of the user's
// subscriptions. The row is atomically claimed (sent_at CAS) BEFORE
// sending — a concurrent deliverer loses the claim and returns 'lost'
// without sending. Dead subscriptions (push service 404/410) are reaped;
// total failure reverts the claim and bumps the attempt counter for the
// next cron pass, up to MAX_ATTEMPTS. `claim: false` is for the /test
// route only, whose fabricated row doesn't exist in D1 — it skips every
// queue write.
export async function deliverNotification(
  repos: Pick<Repos, 'scheduledNotifications' | 'pushSubscriptions'>,
  webPush: WebPushService,
  notification: ScheduledNotificationRecord,
  now: Date,
  opts?: { claim?: boolean },
): Promise<DeliverResult> {
  const claim = opts?.claim ?? true
  if (claim) {
    const claimed = await repos.scheduledNotifications.claimForSend(notification.id, now)
    if (!claimed) return { outcome: 'lost', reapedSubscriptions: 0 }
  }

  const subscriptions = await repos.pushSubscriptions.listByUser(notification.userId)
  if (subscriptions.length === 0) {
    // No devices to deliver to — the claim already retired the row.
    return { outcome: 'retired', reapedSubscriptions: 0 }
  }

  const payload = JSON.stringify({
    title: notification.title,
    ...(notification.body ? { body: notification.body } : {}),
    url: notification.url,
    // Stable OS-level tag: the SW passes it to showNotification so a
    // server push and a locally-fired rest notification share one
    // banner slot (defense-in-depth; the SW's deadline check below is
    // the real dedupe).
    tag: notification.dedupeKey,
    // Rest rows only: the raw client deadline (fireAt is grace-shifted
    // by REST_PUSH_GRACE_MS). The SW shows this backstop silently when
    // a banner for the SAME rest period — matched on this value — is
    // already visible; the tag alone is per-session and would let a
    // stale banner from an earlier rest mute a later rest's alert.
    ...(notification.source === 'rest'
      ? { deadlineMs: notification.fireAt.getTime() - REST_PUSH_GRACE_MS }
      : {}),
  })

  const topic = notificationTopic(notification.dedupeKey)
  let okCount = 0
  let reaped = 0
  let lastError = 'send failed'
  for (const sub of subscriptions) {
    try {
      const result = await webPush.send(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { topic },
      )
      if (result.ok) {
        okCount++
        await repos.pushSubscriptions.markSuccess(sub.idHash, now)
      } else if (result.expired) {
        await repos.pushSubscriptions.deleteByIdHash(sub.idHash)
        reaped++
      } else {
        lastError = `push service status ${result.statusCode}`
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'send threw'
    }
  }

  // The claim already set sent_at, so success paths need no queue write.
  if (okCount > 0) {
    return { outcome: 'delivered', reapedSubscriptions: reaped }
  }
  if (reaped === subscriptions.length) {
    // Every device was dead — nothing left to retry against.
    return { outcome: 'retired', reapedSubscriptions: reaped }
  }
  if (!claim) {
    // /test path: the row isn't real, so there's nothing to retry.
    return { outcome: 'failed', reapedSubscriptions: reaped }
  }
  // Total failure: one guarded write either reverts the claim so the
  // next cron pass retries, or keeps it at MAX_ATTEMPTS so the row stays
  // retired. A null result means the row was revived (reschedule upsert)
  // or re-claimed while the sends were in flight — it belongs to that
  // newer deliverer/schedule now, so write nothing.
  const attempts = await repos.scheduledNotifications.recordFailure(
    notification.id,
    lastError,
    now,
    MAX_ATTEMPTS,
  )
  if (attempts === null) return { outcome: 'lost', reapedSubscriptions: reaped }
  if (attempts >= MAX_ATTEMPTS) return { outcome: 'gaveUp', reapedSubscriptions: reaped }
  return { outcome: 'failed', reapedSubscriptions: reaped }
}

// DO-alarm entry: deliver a single row by id if it's still pending. The
// pending pre-check here is only a cheap fast-path; the atomic claim
// inside deliverNotification is the real gate against the alarm racing a
// cancel (rest skipped) or the cron (already claimed → 'lost').
export async function deliverNotificationById(
  repos: Pick<Repos, 'scheduledNotifications' | 'pushSubscriptions'>,
  webPush: WebPushService,
  id: string,
  now: Date,
): Promise<DeliverResult | null> {
  const notification = await repos.scheduledNotifications.getById(id)
  if (!notification || notification.sentAt || notification.cancelledAt) return null
  return deliverNotification(repos, webPush, notification, now)
}

export interface NotificationTickResult {
  due: number
  delivered: number
  failed: number
  gaveUp: number
  retired: number
  /** Rows another deliverer (usually the DO alarm) claimed mid-sweep. */
  lost: number
  reapedSubscriptions: number
}

// Cron sweep: drain every due row. Normally empty (the DO alarm delivers
// on time); catches rows whose alarm failed to fire or whose deployment
// predates the DO binding.
export async function runNotificationTick(
  repos: Pick<Repos, 'scheduledNotifications' | 'pushSubscriptions'>,
  webPush: WebPushService,
  now: Date,
  opts?: { limit?: number },
): Promise<NotificationTickResult> {
  const due = await repos.scheduledNotifications.listDue(now, opts?.limit ?? 100)
  const result: NotificationTickResult = {
    due: due.length,
    delivered: 0,
    failed: 0,
    gaveUp: 0,
    retired: 0,
    lost: 0,
    reapedSubscriptions: 0,
  }
  for (const notification of due) {
    const r = await deliverNotification(repos, webPush, notification, now)
    result.reapedSubscriptions += r.reapedSubscriptions
    if (r.outcome === 'delivered') result.delivered++
    else if (r.outcome === 'retired') result.retired++
    else if (r.outcome === 'gaveUp') result.gaveUp++
    else if (r.outcome === 'lost') result.lost++
    else result.failed++
  }
  return result
}
