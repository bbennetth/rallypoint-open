// Service-worker-side half of the push self-heal (import from
// '@rallypoint/web-kit/sw-push' — this module must stay free of
// React/DOM imports so it's safe in the SW bundle). See ./push-sync.ts
// for the page-side resync and the overall design.
//
// `pushsubscriptionchange` fires when the push service rotates or
// invalidates a subscription behind the app's back. Without a handler
// the old endpoint stays registered server-side, every send 404/410s,
// the row is reaped, and notifications die silently until the user
// re-toggles them. Chrome/FCM fires this reliably; WebKit rarely does,
// which is why the page-side resync exists as well.

/// <reference lib="webworker" />

export interface PushSubscriptionPayload {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** Narrow a PushSubscription.toJSON() into the payload the APIs accept,
 *  or null when the browser handed us an incomplete subscription. Pure +
 *  unit-tested. */
export function subscriptionPayload(
  json: PushSubscriptionJSON | null | undefined,
): PushSubscriptionPayload | null {
  const endpoint = json?.endpoint
  const p256dh = json?.keys?.p256dh
  const auth = json?.keys?.auth
  if (!endpoint || !p256dh || !auth) return null
  return { endpoint, keys: { p256dh, auth } }
}

/** The endpoint whose server row should be deleted after a rotation:
 *  the old one, but only when it exists and actually differs from the
 *  replacement (a same-endpoint re-register is an in-place upsert, and
 *  deleting it would drop the live row). Pure + unit-tested. */
export function endpointToRemove(
  oldEndpoint: string | null | undefined,
  newEndpoint: string,
): string | null {
  if (!oldEndpoint) return null
  return oldEndpoint === newEndpoint ? null : oldEndpoint
}

/** The `pushsubscriptionchange` event, which TypeScript's webworker lib
 *  doesn't declare. Both fields are absent on some browsers. */
export interface PushSubscriptionChangeEventLike {
  readonly oldSubscription?: PushSubscription | null
  readonly newSubscription?: PushSubscription | null
}

export interface HandleSubscriptionChangeOptions {
  registration: ServiceWorkerRegistration
  oldSubscription?: PushSubscription | null | undefined
  newSubscription?: PushSubscription | null | undefined
  // Injected for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch
  // Request header the API reads the CSRF double-submit token from.
  csrfHeader?: string
}

async function fetchJson<T>(
  doFetch: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T | null> {
  try {
    const res = await doFetch(url, init)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/**
 * Re-subscribe after a push-service rotation and hand the new
 * subscription to the API.
 *
 * Best-effort throughout: a service worker has no UI to fail into, and
 * the page-side resync heals whatever this misses on the next launch.
 * Returns the registered endpoint, or null when nothing could be done.
 */
export async function handlePushSubscriptionChange(
  opts: HandleSubscriptionChangeOptions,
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch
  const csrfHeader = opts.csrfHeader ?? 'X-RP-CSRF'
  try {
    // Some browsers hand us the replacement outright; otherwise
    // re-subscribe with the old subscription's key, falling back to the
    // server's current VAPID key (unauthenticated, same-origin route).
    let subscription = opts.newSubscription ?? null
    if (!subscription) {
      const key =
        opts.oldSubscription?.options.applicationServerKey ??
        (await fetchVapidKey(doFetch))
      if (!key) return null
      subscription = await opts.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      })
    }
    const payload = subscriptionPayload(subscription.toJSON())
    if (!payload) return null

    // The /api/v1/ui/* surface is CSRF double-submit protected. A worker
    // can't read the cookie, but the bootstrap GET is a safe method (so
    // it's exempt) and both returns the token and sets the cookie.
    const csrf = await fetchJson<{ csrfToken?: string }>(doFetch, '/api/v1/ui/csrf', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    const token = csrf?.csrfToken
    if (!token) return null
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      [csrfHeader]: token,
    }

    const res = await doFetch('/api/v1/ui/push/subscription', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(payload),
    })
    // Typically 401 when no session cookie reached the worker — leave it;
    // the page-side resync re-registers on the next launch.
    if (!res.ok) return null

    const stale = endpointToRemove(opts.oldSubscription?.endpoint, payload.endpoint)
    if (stale) {
      // Fire-and-forget: a failed cleanup just leaves a row that the
      // next send reaps on 404/410 anyway.
      await doFetch('/api/v1/ui/push/subscription', {
        method: 'DELETE',
        credentials: 'include',
        headers,
        body: JSON.stringify({ endpoint: stale }),
      }).catch(() => undefined)
    }
    return payload.endpoint
  } catch {
    return null
  }
}

async function fetchVapidKey(doFetch: typeof fetch): Promise<Uint8Array<ArrayBuffer> | null> {
  const body = await fetchJson<{ publicKey?: string }>(doFetch, '/api/v1/push/public-key')
  const publicKey = body?.publicKey
  if (!publicKey) return null
  try {
    return urlBase64ToUint8Array(publicKey)
  } catch {
    return null
  }
}

/** Convert a base64url VAPID public key into the Uint8Array the
 *  PushManager expects as `applicationServerKey` (a BufferSource =
 *  ArrayBuffer-backed view). Pure + unit-tested. Lives here (not in
 *  push-sync.ts) so the SW bundle can use it without pulling in the
 *  page-side module. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Register the `pushsubscriptionchange` listener on a SW global. The
 *  event type isn't in TypeScript's webworker lib, hence the cast. */
export function swPushSubscriptionChangeListener(scope: ServiceWorkerGlobalScope): void {
  scope.addEventListener('pushsubscriptionchange', (event) => {
    const e = event as ExtendableEvent & PushSubscriptionChangeEventLike
    e.waitUntil(
      handlePushSubscriptionChange({
        registration: scope.registration,
        oldSubscription: e.oldSubscription,
        newSubscription: e.newSubscription,
      }).catch(() => null),
    )
  })
}
