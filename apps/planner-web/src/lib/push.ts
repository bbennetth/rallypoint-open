import { registerPushSubscription, removePushSubscription } from './api.js'

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

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''

// Ask for permission, subscribe, and register with the backend. Returns
// 'denied' if the user declined the OS/browser prompt, 'unsupported' if Web
// Push isn't available (or no VAPID key is configured), 'subscribed' on success.
export async function enablePush(): Promise<EnablePushResult> {
  if (!pushSupported() || !VAPID_PUBLIC_KEY) return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
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
