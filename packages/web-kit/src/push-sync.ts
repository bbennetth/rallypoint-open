// Page-side Web Push self-heal, shared by the Rallypoint PWAs.
//
// The failure this exists for: Apple's push service rotates/invalidates
// the endpoint of an installed iOS PWA after a day or so. The server
// send then 404/410s and correctly reaps the subscription row — but the
// browser keeps its (now dead) local subscription, the user's "push on"
// setting stays true, and nothing ever re-subscribes. Notifications die
// silently until the user toggles them off and on, which is the only
// code path that re-subscribes.
//
// The heal runs on launch AND on tab-visible (an installed iOS PWA is
// resumed for days without a fresh launch, so a mount-only hook would
// almost never fire there), throttled so an app-switch burst costs
// nothing.
//
// Two subtleties drive the design:
//
//  1. A local subscription can be a zombie — alive to the browser, dead
//     at the push service. Re-POSTing it would loop forever
//     (register → 410 → reap → register), so when the local subscription
//     LOOKS healthy we ask the server whether it still holds the row.
//     A missing row is evidence of a reap, and only then do we cycle.
//  2. WebKit rejects pushManager.subscribe() outside a user gesture even
//     when permission is already granted. A background heal that needs a
//     fresh subscription therefore retries inside the next tap, with the
//     registration and key pre-resolved so the only await inside the
//     gesture is subscribe() itself.

import { endpointToRemove, subscriptionPayload, urlBase64ToUint8Array } from './sw-push.js'
import type { PushSubscriptionPayload } from './sw-push.js'

export type { PushSubscriptionPayload }
export { urlBase64ToUint8Array }

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

/**
 * Compare an existing subscription's applicationServerKey against the
 * server's current VAPID public key. `existing` is
 * subscription.options.applicationServerKey — an ArrayBuffer on Chrome/
 * Firefox, but null on some browsers (Safari). On null we can't prove a
 * mismatch, so treat it as a match: force-cycling a subscription we
 * can't inspect risks breaking a working one, and the verify step below
 * catches a genuinely dead one anyway. Pure + unit-tested.
 */
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

export type ResyncAction = 'none' | 'verify' | 'resubscribe'

/**
 * What the resync should do this run. Pure + unit-tested.
 *
 * - Not opted in, or permission not granted → nothing (we never prompt).
 * - No local subscription (iOS dropped it) or one made under a stale
 *   server key → subscribe afresh.
 * - A plausible-looking local subscription → ask the server whether it
 *   is still registered before touching anything.
 */
export function resyncAction(input: {
  enabled: boolean
  permission: NotificationPermission
  hasSubscription: boolean
  keyMatches: boolean
}): ResyncAction {
  if (!input.enabled) return 'none'
  if (input.permission !== 'granted') return 'none'
  if (!input.hasSubscription) return 'resubscribe'
  return input.keyMatches ? 'verify' : 'resubscribe'
}

/** How long a successful (or attempted) sync suppresses the next one. */
export const PUSH_SYNC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Whether enough time has passed since the last sync attempt. Pure +
 *  unit-tested. A `lastSyncAt` in the future means the clock moved
 *  backwards (or storage was tampered with) — don't wedge the heal shut
 *  for hours, just sync. */
export function shouldSyncPush(lastSyncAt: number | null, now: number): boolean {
  if (lastSyncAt == null || !Number.isFinite(lastSyncAt)) return true
  if (lastSyncAt > now) return true
  return now - lastSyncAt >= PUSH_SYNC_MIN_INTERVAL_MS
}

export type PushHealthReason = 'denied' | 'default' | 'blocked' | null

/**
 * Why a user who has push switched ON isn't actually going to get
 * notifications, or null when everything looks healthy. Apps map the
 * reason to their own settings copy. Pure + unit-tested.
 */
export function pushHealthReason(input: {
  enabled: boolean
  permission: NotificationPermission
  resyncBlocked: boolean
}): PushHealthReason {
  if (!input.enabled) return null
  if (input.permission === 'denied') return 'denied'
  if (input.permission === 'default') return 'default'
  return input.resyncBlocked ? 'blocked' : null
}

export type PushSyncResult =
  // Not applicable: unsupported, not opted in, or permission not granted.
  | 'skipped'
  // The server already holds this subscription — nothing to do.
  | 'healthy'
  // An existing subscription was (re-)registered with the server.
  | 'registered'
  // A fresh subscription replaced a dead/stale one.
  | 'resubscribed'
  // A fresh subscription is needed but the browser refused outside a
  // user gesture; a retry is armed on the next interaction.
  | 'blocked'
  // Something went wrong (offline, bad key, API error) — try again later.
  | 'failed'

export interface PushResyncAdapter {
  /** Has the user opted into notifications on this app? Read from the
   *  app's own settings; may hit the network (cached reads preferred). */
  isEnabled(): Promise<boolean>
  /** POST the subscription to the app's API. */
  register(payload: PushSubscriptionPayload): Promise<void>
  /** Does the server still hold a row for this endpoint? */
  verify(endpoint: string): Promise<boolean>
  /** Drop a replaced endpoint's row. Optional but strongly preferred:
   *  a subscription replaced for a STALE KEY 403s at send time rather
   *  than 404/410, so the server-side reap never removes it and every
   *  delivery would fan out to both the dead row and the live one. */
  unregister?(endpoint: string): Promise<void>
  /** localStorage key prefix, so co-installed apps don't share slots. */
  storagePrefix: string
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Injected for tests; defaults to Date.now. */
  now?: () => number
}

export interface PushResync {
  /** Heal now, ignoring the throttle (use inside an explicit user
   *  action, where a fresh subscribe is allowed to prompt the platform). */
  sync(): Promise<PushSyncResult>
  /** Heal at most once per PUSH_SYNC_MIN_INTERVAL_MS. */
  maybeSync(): Promise<PushSyncResult | 'throttled'>
  /** Whether the last heal needed a subscribe the browser refused. */
  isBlocked(): boolean
  /** Record an externally-performed sync (e.g. the settings toggle) so
   *  the throttle and blocked marker stay in step. */
  markSynced(): void
  /** Scope the throttle/blocked slots to the signed-in user, so a shared
   *  device doesn't carry one account's state into another's session.
   *  Called by `usePushSync` once the session resolves. */
  setScope(userId: string | null | undefined): void
}

function readSlot(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    // Storage unavailable (private mode edge cases) — behave as unset.
    return null
  }
}

function writeSlot(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable — the throttle degrades to per-call, which is
    // correct-but-chattier. Never break the heal over it.
  }
}

function clearSlot(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

// Fetch the app's VAPID public key at runtime. Served by the worker (not
// baked into the build) so the browser always subscribes with the
// keypair THIS deploy's worker signs with — a build-time key can drift
// from the server's and every push then 403s at send time.
async function fetchVapidPublicKey(doFetch: typeof fetch): Promise<string | null> {
  try {
    const res = await doFetch('/api/v1/push/public-key')
    if (!res.ok) return null
    const body = (await res.json()) as { publicKey?: string }
    return body.publicKey || null
  } catch {
    return null
  }
}

// WebKit throws NotAllowedError when subscribe() runs outside a user
// gesture. Anything else is a real failure worth reporting as such.
function isGestureRefusal(err: unknown): boolean {
  return err instanceof Error && err.name === 'NotAllowedError'
}

/**
 * Build the app's push self-heal. One instance per app (module-level),
 * so the single-flight and gesture-retry state is shared by every
 * caller.
 */
export function createPushResync(adapter: PushResyncAdapter): PushResync {
  const doFetch = adapter.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const now = adapter.now ?? (() => Date.now())

  // Slots are per-user as well as per-app: on a shared device a fresh
  // sign-in must not inherit the previous account's throttle stamp (which
  // would suppress the new user's first heal for up to a whole window) or
  // its blocked marker. `usePushSync` sets the scope once the session
  // resolves; before that the unscoped slots are used, which is correct
  // for the pre-auth window where no heal can run anyway.
  let scope: string | null = null

  // The pair of slot keys a given run writes through. Resolved ONCE at
  // the top of a run and passed down, so a `setScope` landing mid-heal
  // (a fast account switch) can't redirect that run's tail writes into
  // the new account's slots.
  interface Slots {
    syncedAt: string
    blocked: string
  }

  function currentSlots(): Slots {
    const prefix = scope === null ? adapter.storagePrefix : `${adapter.storagePrefix}.${scope}`
    return { syncedAt: `${prefix}.pushSyncAt`, blocked: `${prefix}.pushResyncBlocked` }
  }

  function setScope(userId: string | null | undefined): void {
    scope = userId ?? null
  }

  // One heal at a time: mount and visibilitychange can fire together.
  let inflight: Promise<PushSyncResult> | null = null
  // At most one armed gesture listener at a time.
  let gestureArmed = false
  // …and at most one retry subscribe actually in flight. A listener is
  // re-armable the moment the previous one fires (see armGestureRetry),
  // so without this two taps could overlap two `subscribe()` calls for
  // the same registration+key.
  let retryInflight: Promise<void> | null = null

  function isBlocked(): boolean {
    return readSlot(currentSlots().blocked) === '1'
  }

  function setBlocked(slots: Slots, blocked: boolean): void {
    if (blocked) writeSlot(slots.blocked, '1')
    else clearSlot(slots.blocked)
  }

  function markSynced(): void {
    const slots = currentSlots()
    writeSlot(slots.syncedAt, String(now()))
    setBlocked(slots, false)
  }

  async function registerSubscription(
    slots: Slots,
    subscription: PushSubscription,
    replacedEndpoint?: string | null,
  ): Promise<boolean> {
    const payload = subscriptionPayload(subscription.toJSON())
    if (!payload) return false
    await adapter.register(payload)
    setBlocked(slots, false)
    const stale = endpointToRemove(replacedEndpoint, payload.endpoint)
    if (stale && adapter.unregister) {
      // Fire-and-forget: a failed cleanup only leaves a row that costs a
      // wasted send, and the next heal tries again.
      await adapter.unregister(stale).catch(() => undefined)
    }
    return true
  }

  // Retry the refused subscribe inside the next tap's transient
  // activation. Everything the call needs is resolved up front — the
  // only await between the gesture and subscribe() is subscribe()
  // itself, because activation expires fast.
  function armGestureRetry(
    slots: Slots,
    registration: ServiceWorkerRegistration,
    key: Uint8Array<ArrayBuffer>,
    replacedEndpoint: string | null,
  ): void {
    if (gestureArmed || typeof document === 'undefined') return
    gestureArmed = true
    const onGesture = (): void => {
      document.removeEventListener('pointerup', onGesture, true)
      document.removeEventListener('click', onGesture, true)
      // Disarm as soon as the listeners are off, NOT after the retry
      // settles: `subscribe()` has no timeout, and a hung call would
      // otherwise leave the flag stuck true with no listener attached —
      // permanently dead until a reload, which is the very "silently
      // stops healing" failure this module exists to prevent. Re-arming
      // is therefore free; `retryInflight` (not the flag) is what keeps
      // two taps from overlapping two subscribe() calls.
      gestureArmed = false
      retryInflight ??= (async () => {
        try {
          const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
          })
          await registerSubscription(slots, subscription, replacedEndpoint)
        } catch {
          // Still refused (or the API rejected it) — leave the blocked
          // marker set so Settings can say so, and let the next throttle
          // window try again.
        }
      })().finally(() => {
        retryInflight = null
      })
      void retryInflight
    }
    document.addEventListener('pointerup', onGesture, true)
    document.addEventListener('click', onGesture, true)
  }

  async function subscribeAndRegister(
    slots: Slots,
    registration: ServiceWorkerRegistration,
    key: Uint8Array<ArrayBuffer>,
    replacedEndpoint: string | null,
  ): Promise<PushSyncResult> {
    try {
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      })
      return (await registerSubscription(slots, subscription, replacedEndpoint))
        ? 'resubscribed'
        : 'failed'
    } catch (err) {
      if (isGestureRefusal(err)) {
        setBlocked(slots, true)
        armGestureRetry(slots, registration, key, replacedEndpoint)
        return 'blocked'
      }
      return 'failed'
    }
  }

  async function run(): Promise<PushSyncResult> {
    // Freeze the slot identity for this whole run (see Slots above).
    const slots = currentSlots()
    try {
      if (!pushSupported()) return 'skipped'
      if (Notification.permission !== 'granted') return 'skipped'
      if (!(await adapter.isEnabled())) return 'skipped'

      const publicKey = await fetchVapidPublicKey(doFetch)
      if (!publicKey) return 'failed'
      const expectedKey = urlBase64ToUint8Array(publicKey)
      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()

      const action = resyncAction({
        enabled: true,
        permission: Notification.permission,
        hasSubscription: existing != null,
        keyMatches: existing
          ? serverKeyMatches(existing.options.applicationServerKey, expectedKey)
          : true,
      })
      if (action === 'none') return 'skipped'

      if (action === 'verify' && existing) {
        if (await adapter.verify(existing.endpoint)) {
          setBlocked(slots, false)
          return 'healthy'
        }
        // The server has no row for a subscription the browser still
        // holds: it was reaped after a 404/410, deleted, or handed to
        // another user. Re-registering the same endpoint would just be
        // reaped again, so cycle it. No stale row to clean up — the
        // server already has none for this endpoint.
        await existing.unsubscribe().catch(() => undefined)
        return subscribeAndRegister(slots, registration, expectedKey, null)
      }

      // 'resubscribe': drop a stale-key subscription first so the
      // replacement isn't shadowed by it. Its server row is worth
      // deleting explicitly — a stale-key send 403s rather than 404/410,
      // so the reap never clears it.
      const replaced = existing?.endpoint ?? null
      if (existing) await existing.unsubscribe().catch(() => undefined)
      return subscribeAndRegister(slots, registration, expectedKey, replaced)
    } catch {
      return 'failed'
    }
  }

  function sync(): Promise<PushSyncResult> {
    inflight ??= run().finally(() => {
      inflight = null
    })
    return inflight
  }

  async function maybeSync(): Promise<PushSyncResult | 'throttled'> {
    const slots = currentSlots()
    const raw = readSlot(slots.syncedAt)
    // A garbage slot parses to NaN, which shouldSyncPush already treats
    // as "never synced" via its finite check.
    const last = raw == null ? null : Number.parseInt(raw, 10)
    const stamp = now()
    if (!shouldSyncPush(last, stamp)) return 'throttled'
    // Stamp BEFORE running: an attempt-based throttle keeps a
    // persistently-blocked device (WebKit refusing every background
    // subscribe) from re-running on every app-switch.
    writeSlot(slots.syncedAt, String(stamp))
    return sync()
  }

  return { sync, maybeSync, isBlocked, markSynced, setScope }
}
