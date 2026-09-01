// Server-side rest-timer push: while a rest period runs, a scheduled
// notification is parked on fitness-api (delivered by a DO alarm at the
// deadline) so the alert still lands when the OS suspends or kills the
// tab. The existing local sound / SW notification remains the primary
// alert while the page is alive — the server push is a backstop parked
// REST_PUSH_GRACE_MS after the deadline, and the SW shows it silently
// in place when this rest period's local banner is already up
// (deadline match in sw.ts; the shared tag is defense-in-depth).
//
// Pure decision helpers live up top (unit-tested); the side-effecting
// subscribe/schedule wrappers below stay thin.

import {
  createPushResync,
  pushHealthReason,
  pushSupported,
  serverKeyMatches,
  urlBase64ToUint8Array,
} from '@rallypoint/web-kit'
import type { PushHealthReason } from '@rallypoint/web-kit'
import {
  cancelRestPush,
  registerPushSubscription,
  removePushSubscription,
  scheduleRestPush,
  verifyPushSubscription,
} from './api.js'
import type { TestPushResult } from './api.js'
import { getRestAlertsMode } from './alert-settings.js'
import type { NotificationPermissionState, RestAlertsMode } from './rest-alerts.js'

// Re-exported from web-kit so existing importers (and their tests) keep
// one import site; the implementations are shared with planner-web.
export { pushSupported, serverKeyMatches, urlBase64ToUint8Array }

/** Whether a rest period should park a server-side push: the user opted
 *  into notifications, the browser permission is still granted, and
 *  we're online (offline → the local alert already covers the case; a
 *  late-drained rest push would be worse than none, so this NEVER goes
 *  through the outbox). */
export function shouldScheduleRestPush(
  mode: RestAlertsMode,
  permission: NotificationPermissionState,
  online: boolean,
  supported: boolean = pushSupported(),
): boolean {
  return supported && online && mode === 'notify' && permission === 'granted'
}

/** The url-safe scheduling tag for a live session (also the OS
 *  notification tag suffix — one pending rest push per session). */
export function restPushTag(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** The OS-level notification tag for a session's rest alerts — the SAME
 *  value the server stamps on its push payload (the queue dedupe key).
 *  It's the lookup key for the SW's duplicate check
 *  (getNotifications({tag}) + deadline match in sw.ts) and, as
 *  defense-in-depth, makes a local notification and a server push for
 *  one rest period share a single banner slot. */
export function restNotificationTag(sessionId: string): string {
  return `rest:${restPushTag(sessionId)}`
}

/** Settings status line after the +Notify tap tried to arm background
 *  push. Pure + unit-tested. `null` (subscribed) → no line at all: the
 *  quiet path is the healthy one. */
export function restPushStatusMessage(subscribed: boolean, supported: boolean): string | null {
  if (!supported) return 'Background alerts need the installed app (iOS 16.4+).'
  if (!subscribed) {
    return 'Background alerts couldn’t be enabled on this device — sound and in-app alerts still work.'
  }
  return null
}

/** Map the /push/test response to the settings status line. Pure +
 *  unit-tested; mirrors planner-web's testPushStatusMessage. */
export function testPushStatusMessage(result: TestPushResult): string {
  if (!result.registered) return 'No devices registered yet — re-enable +Notify first.'
  if (result.delivered) return 'Sent — background the app and check for the notification.'
  return 'Couldn’t reach any device. Try turning +Notify off and on again.'
}

/** Settings-page copy for +Notify that can no longer deliver. `null`
 *  when healthy. Pure + unit-tested. */
export function restPushHealthMessage(reason: PushHealthReason): string | null {
  switch (reason) {
    case 'denied':
      return 'Notifications are blocked — enable them in your device settings, then pick +Notify again.'
    case 'default':
      return 'Notifications need permission again — tap +Notify to re-enable them.'
    case 'blocked':
      return 'Reconnecting background alerts — if they stay missing, tap Sound then +Notify again.'
    default:
      return null
  }
}

// Fitness's push self-heal. Apple rotates the push endpoint of an
// installed iOS PWA after a day or so; the server reaps the row on the
// resulting 404/410 and — before this — nothing re-subscribed, so rest
// pushes silently stopped until the user re-picked +Notify. Registered
// against the rest-alerts preference: only a 'notify' user gets healed.
export const pushResync = createPushResync({
  isEnabled: () => Promise.resolve(getRestAlertsMode() === 'notify'),
  register: registerPushSubscription,
  verify: verifyPushSubscription,
  unregister: removePushSubscription,
  storagePrefix: 'fitness',
})

/** Whether the last heal needed a subscribe the browser refused (WebKit
 *  requires a user gesture). Surfaced on the settings page. */
export function restPushBlocked(): boolean {
  return pushResync.isBlocked()
}

/** The settings status line for a +Notify selection that can't deliver.
 *  Returns null when healthy, or when push isn't supported at all (the
 *  option is already disabled there). */
export function restPushHealthStatus(): string | null {
  if (!pushSupported()) return null
  return restPushHealthMessage(
    pushHealthReason({
      enabled: getRestAlertsMode() === 'notify',
      permission: Notification.permission,
      resyncBlocked: restPushBlocked(),
    }),
  )
}

/**
 * Make sure this browser's push subscription is registered with
 * fitness-api. Never prompts for permission: callers only invoke this
 * when permission is already granted (the rest-alerts settings flow owns
 * the prompt).
 *
 * Call this from inside a user gesture — WebKit rejects
 * pushManager.subscribe() without one, which is why the +Notify tap owns
 * the first subscribe. Background callers should use the throttled heal
 * (`pushResync.maybeSync()`, mounted app-wide by usePushSync) instead.
 */
export async function ensureRestPushSubscription(): Promise<boolean> {
  const result = await pushResync.sync()
  return result === 'healthy' || result === 'registered' || result === 'resubscribed'
}

/** Park (or move — the server upserts on the tag) the rest push for a
 *  session. Fire-and-forget: failures degrade to local-only alerts. */
export async function armRestPush(
  sessionId: string,
  deadlineMs: number,
  nextUp: string,
): Promise<void> {
  try {
    // Throttled heal first, so a rotated endpoint is re-registered
    // before we park work against it. Awaited for that ordering, but
    // deliberately NOT gated on its result: in the steady state it
    // returns 'throttled', which says nothing about health, and a
    // blocked or briefly-offline heal shouldn't stop us parking a push
    // against a subscription that is very likely still good.
    await pushResync.maybeSync()
    await scheduleRestPush(restPushTag(sessionId), deadlineMs, nextUp || undefined)
  } catch {
    // Local alert still covers it.
  }
}

/** Cancel the parked rest push (rest finished/skipped, or the page
 *  delivered the alert locally). Fire-and-forget. */
export async function disarmRestPush(sessionId: string): Promise<void> {
  try {
    await cancelRestPush(restPushTag(sessionId))
  } catch {
    // Worst case the push fires anyway; the SW's deadline check (or,
    // failing that, the OS tag) keeps it from doubling the banner.
  }
}
