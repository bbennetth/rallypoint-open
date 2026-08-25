import { registerPushSubscription, removePushSubscription } from './api.js'
import type { TestPushResult } from './api.js'

// Browser-side Web Push setup: request permission, subscribe via the
// PushManager with the VAPID applicationServerKey, and register the
// subscription with planner-api. The reverse on disable.

// Convert a base64url VAPID public key into the Uint8Array the PushManager
// expects as `applicationServerKey` (a BufferSource = ArrayBuffer-backed view).
// Pure + unit-tested.
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export type EnablePushResult = 'subscribed' | 'denied' | 'unsupported'

// Map the /push/test response to the settings-page status line. Pure +
// unit-tested; the backend deliberately returns booleans, not device counts.
export function testPushStatusMessage(result: TestPushResult): string {
  if (!result.registered) return 'No devices registered yet — turn notifications on first.'
  if (result.delivered) return 'Sent — check for the notification.'
  return 'Couldn’t reach any device. Try turning notifications off and on again.'
}

// True when this browser can do Web Push at all.
export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
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

// Compare an existing subscription's applicationServerKey against the
// server's current VAPID public key. `existing` is
// subscription.options.applicationServerKey — an ArrayBuffer on Chrome/
// Firefox, but null on some browsers (Safari). On null we can't prove a
// mismatch, so treat it as a match: force-cycling a subscription we can't
// inspect risks breaking a working one, and the server reaps dead
// subscriptions on send anyway. Pure + unit-tested.
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
