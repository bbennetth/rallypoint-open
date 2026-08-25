// Server-side rest-timer push: while a rest period runs, a scheduled
// notification is parked on fitness-api (delivered by a DO alarm at the
// deadline) so the alert still lands when the OS suspends or kills the
// tab. The existing local sound / SW notification remains the primary
// alert while the page is alive — the server push is the backstop, and
// the shared notification tag collapses the two at the OS level.
//
// Pure decision helpers live up top (unit-tested); the side-effecting
// subscribe/schedule wrappers below stay thin.

import {
  cancelRestPush,
  registerPushSubscription,
  removePushSubscription,
  scheduleRestPush,
} from './api.js'
import type { TestPushResult } from './api.js'
import type { NotificationPermissionState, RestAlertsMode } from './rest-alerts.js'

/** Whether this browser can do Web Push at all. */
export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
}

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

/** Convert a base64url VAPID public key into the Uint8Array the
 *  PushManager expects as applicationServerKey. Pure. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** The url-safe scheduling tag for a live session (also the OS
 *  notification tag suffix — one pending rest push per session). */
export function restPushTag(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** The OS-level notification tag for a session's rest alerts — the SAME
 *  value the server stamps on its push payload (the queue dedupe key),
 *  so a local notification and a server push for one rest period
 *  collapse into a single banner. */
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

// Fetch the VAPID public key from fitness-api at runtime. Served by the
// worker (not baked into the build) so the browser always subscribes with
// the keypair this deploy's worker actually signs with — a build-time key
// can drift from the server's and every push then 403s at send time.
async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/v1/push/public-key')
    if (!res.ok) return null
    const body = (await res.json()) as { publicKey?: string }
    return body.publicKey || null
  } catch {
    return null
  }
}

// Compare an existing subscription's applicationServerKey against the
// server's current VAPID public key. `existing` is
// subscription.options.applicationServerKey — an ArrayBuffer on Chrome/
// Firefox, but null on some browsers (Safari). On null we can't prove a
// mismatch, so treat it as a match: force-cycling a subscription we can't
// inspect risks breaking a working one, and the server reaps dead
// subscriptions on send anyway. Pure + unit-tested; mirrors planner-web.
export function serverKeyMatches(
  existing: ArrayBuffer | null | undefined,
  expected: Uint8Array,
): boolean {
  if (existing == null) return true
  const bytes = new Uint8Array(existing)
  if (bytes.length !== expected.length) return false
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== expected[i]) return false
  }
  return true
}

// Make sure this browser's push subscription is registered with
// fitness-api. Never prompts: callers only invoke this when permission is
// already granted (the rest-alerts settings flow owns the prompt).
// Memoized per page load — the subscription is endpoint-stable. A
// subscription made under a stale server key is unsubscribed and replaced
// so it self-heals without the user toggling anything.
let ensured: Promise<boolean> | null = null
export function ensureRestPushSubscription(): Promise<boolean> {
  ensured ??= (async () => {
    try {
      if (!pushSupported()) return false
      if (Notification.permission !== 'granted') return false
      const publicKey = await fetchVapidPublicKey()
      if (!publicKey) return false
      const registration = await navigator.serviceWorker.ready
      const expectedKey = urlBase64ToUint8Array(publicKey)
      let existing = await registration.pushManager.getSubscription()
      let staleEndpoint: string | null = null
      if (existing && !serverKeyMatches(existing.options.applicationServerKey, expectedKey)) {
        // Remember the replaced endpoint so its server row can be deleted
        // below — a stale-key row 403s at send time (never 404/410), so
        // the server-side reap never removes it, and every delivery would
        // otherwise fan out to both the dead and the live subscription.
        staleEndpoint = existing.endpoint
        await existing.unsubscribe().catch(() => undefined)
        existing = null
      }
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: expectedKey,
        }))
      const json = subscription.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false
      await registerPushSubscription({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      })
      if (staleEndpoint && staleEndpoint !== json.endpoint) {
        // Fire-and-forget: a failed cleanup just leaves the old row to
        // rot until this runs again.
        void removePushSubscription(staleEndpoint).catch(() => undefined)
      }
      return true
    } catch {
      return false
    }
  })()
  // A failed attempt shouldn't poison the rest of the session.
  void ensured.then((ok) => {
    if (!ok) ensured = null
  })
  return ensured
}

/** Park (or move — the server upserts on the tag) the rest push for a
 *  session. Fire-and-forget: failures degrade to local-only alerts. */
export async function armRestPush(
  sessionId: string,
  deadlineMs: number,
  nextUp: string,
): Promise<void> {
  try {
    if (!(await ensureRestPushSubscription())) return
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
    // Worst case the push fires anyway; the OS tag collapses duplicates.
  }
}
