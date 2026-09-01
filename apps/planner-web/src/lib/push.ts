import {
  createPushResync,
  pushHealthReason,
  pushSupported,
  serverKeyMatches,
  urlBase64ToUint8Array,
} from '@rallypoint/web-kit'
import type { PushHealthReason } from '@rallypoint/web-kit'
import {
  getSettings,
  PUSH_NOTIFICATIONS_KEY,
  registerPushSubscription,
  removePushSubscription,
  verifyPushSubscription,
} from './api.js'
import type { TestPushResult } from './api.js'

// Browser-side Web Push setup: request permission, subscribe via the
// PushManager with the VAPID applicationServerKey, and register the
// subscription with planner-api. The reverse on disable.
//
// The self-heal that keeps this alive past day one (iOS rotates push
// endpoints behind the app's back) lives in @rallypoint/web-kit's
// push-sync, shared with fitness-web; `pushResync` below is planner's
// instance of it, mounted by AppChrome via usePushSync.

// Re-exported from web-kit so existing importers (and their tests) keep
// one import site; the implementations are shared with fitness-web.
export { pushSupported, serverKeyMatches, urlBase64ToUint8Array }

export type EnablePushResult = 'subscribed' | 'denied' | 'unsupported'

// Map the /push/test response to the settings-page status line. Pure +
// unit-tested; the backend deliberately returns booleans, not device counts.
export function testPushStatusMessage(result: TestPushResult): string {
  if (!result.registered) return 'No devices registered yet — turn notifications on first.'
  if (result.delivered) return 'Sent — check for the notification.'
  return 'Couldn’t reach any device. Try turning notifications off and on again.'
}

/** Settings-page copy for a toggle that says ON while notifications
 *  can't actually arrive. `null` when nothing is wrong. Pure +
 *  unit-tested. */
export function pushHealthStatusMessage(reason: PushHealthReason): string | null {
  switch (reason) {
    case 'denied':
      return 'Notifications are blocked — enable them in your device or browser settings, then turn this off and on again.'
    case 'default':
      return 'Notifications need permission again — turn this off and on to re-enable them.'
    case 'blocked':
      return 'Reconnecting notifications on this device — if reminders stay missing, turn this off and on again.'
    default:
      return null
  }
}

// Fetch the VAPID public key from planner-api at runtime. Served by the
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

// Planner's push self-heal: re-registers (or re-subscribes) whenever the
// user has notifications on but the server has lost the subscription.
export const pushResync = createPushResync({
  isEnabled: async () => {
    try {
      const settings = await getSettings('planner')
      return settings[PUSH_NOTIFICATIONS_KEY] === true
    } catch {
      // Offline / API down — don't guess "on" and churn subscriptions.
      return false
    }
  },
  register: (payload) => registerPushSubscription(payload, 'resync'),
  verify: verifyPushSubscription,
  // A stale-KEY replacement 403s at send time rather than 404/410, so the
  // server-side reap never clears the old row — delete it explicitly.
  unregister: removePushSubscription,
  storagePrefix: 'planner',
})

/** Whether the last heal needed a subscribe the browser refused (WebKit
 *  requires a user gesture). Surfaced on the settings page. */
export function pushResyncBlocked(): boolean {
  return pushResync.isBlocked()
}

// Ask for permission, subscribe, and register with the backend. Returns
// 'denied' if the user declined the OS/browser prompt, 'unsupported' if Web
// Push isn't available (or the key fetch failed), 'subscribed' on success.
// A subscription made under a stale server key is unsubscribed and replaced
// so it self-heals without the user having to toggle anything.
export async function enablePush(): Promise<EnablePushResult> {
  if (!pushSupported()) return 'unsupported'
  const publicKey = await fetchVapidPublicKey()
  if (!publicKey) return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const registration = await navigator.serviceWorker.ready
  const expectedKey = urlBase64ToUint8Array(publicKey)
  let existing = await registration.pushManager.getSubscription()
  if (existing && !serverKeyMatches(existing.options.applicationServerKey, expectedKey)) {
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
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return 'unsupported'
  await registerPushSubscription({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  })
  // This tap IS a sync: start the throttle window here and clear any
  // stale "the browser refused" marker from an earlier background heal.
  pushResync.markSynced()
  return 'subscribed'
}

// Unsubscribe locally and tell the backend to drop the subscription.
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return
  const { endpoint } = subscription
  await subscription.unsubscribe().catch(() => undefined)
  await removePushSubscription(endpoint)
}

/** The settings-page status line for a toggle that reads ON but can't
 *  deliver. Returns null when healthy (or push isn't supported at all,
 *  where the toggle is already disabled). */
export function pushHealthStatus(enabled: boolean): string | null {
  if (!pushSupported()) return null
  return pushHealthStatusMessage(
    pushHealthReason({
      enabled,
      permission: Notification.permission,
      resyncBlocked: pushResyncBlocked(),
    }),
  )
}
