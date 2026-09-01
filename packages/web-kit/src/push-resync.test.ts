// Behavioral tests for the createPushResync orchestrator — the actual
// iOS heal, driven over fake PushManager/Notification/localStorage.
// The pure decision helpers are covered in push-sync.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPushResync, type PushResyncAdapter } from './push-sync.js'

const VAPID_KEY = 'BMtiizjeUZ7oRAzgJkYldtNsBFin0L1VdojVUccJqDzYjoOE0mkyQJ35H-4y2A4-gASqZh1A3ae2ADWzmSw_0so'

function fakeSubscription(endpoint: string, applicationServerKey: ArrayBuffer | null = null) {
  return {
    endpoint,
    options: { applicationServerKey },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  }
}

interface Harness {
  adapter: PushResyncAdapter
  register: ReturnType<typeof vi.fn>
  verify: ReturnType<typeof vi.fn>
  unregister: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  getSubscription: ReturnType<typeof vi.fn>
  store: Map<string, string>
}

function harness(opts: {
  enabled?: boolean
  permission?: NotificationPermission
  existing?: ReturnType<typeof fakeSubscription> | null
  verifyResult?: boolean
  subscribeImpl?: () => Promise<unknown>
} = {}): Harness {
  const existing = opts.existing === undefined ? null : opts.existing
  const store = new Map<string, string>()
  const getSubscription = vi.fn().mockResolvedValue(existing)
  const subscribe =
    opts.subscribeImpl !== undefined
      ? vi.fn(opts.subscribeImpl)
      : vi.fn().mockResolvedValue(fakeSubscription('https://push.example/fresh'))
  const register = vi.fn().mockResolvedValue(undefined)
  const verify = vi.fn().mockResolvedValue(opts.verifyResult ?? true)
  const unregister = vi.fn().mockResolvedValue(undefined)

  vi.stubGlobal('navigator', {
    serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) },
  })
  vi.stubGlobal('Notification', { permission: opts.permission ?? 'granted' })
  vi.stubGlobal('PushManager', class {})
  vi.stubGlobal('window', {
    PushManager: class {},
    Notification: class {},
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })

  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ publicKey: VAPID_KEY }),
  }) as unknown as typeof fetch

  return {
    adapter: {
      isEnabled: () => Promise.resolve(opts.enabled ?? true),
      register,
      verify,
      unregister,
      storagePrefix: 'testapp',
      fetchImpl,
    },
    register,
    verify,
    unregister,
    subscribe,
    getSubscription,
    store,
  }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createPushResync — the iOS heal', () => {
  it('leaves a verified-live subscription alone', async () => {
    const h = harness({ existing: fakeSubscription('https://push.example/live'), verifyResult: true })
    const resync = createPushResync(h.adapter)

    expect(await resync.sync()).toBe('healthy')
    expect(h.verify).toHaveBeenCalledWith('https://push.example/live')
    // The whole point of the verify step: a working subscription is
    // never cycled, and no redundant register is issued.
    expect(h.subscribe).not.toHaveBeenCalled()
    expect(h.register).not.toHaveBeenCalled()
  })

  it('cycles a zombie subscription the server has already reaped', async () => {
    // The bug this fix exists for: iOS keeps a local subscription whose
    // endpoint Apple killed, so the server reaped the row on 404/410.
    const dead = fakeSubscription('https://push.example/reaped')
    const h = harness({ existing: dead, verifyResult: false })
    const resync = createPushResync(h.adapter)

    expect(await resync.sync()).toBe('resubscribed')
    expect(dead.unsubscribe).toHaveBeenCalled()
    expect(h.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    )
    expect(h.register).toHaveBeenCalledWith({
      endpoint: 'https://push.example/fresh',
      keys: { p256dh: 'p256dh', auth: 'auth' },
    })
    // No stale row to clean: the server already had none for it.
    expect(h.unregister).not.toHaveBeenCalled()
  })

  it('subscribes fresh when iOS dropped the local subscription entirely', async () => {
    const h = harness({ existing: null })
    const resync = createPushResync(h.adapter)

    expect(await resync.sync()).toBe('resubscribed')
    // Nothing to verify — there was no endpoint to ask about.
    expect(h.verify).not.toHaveBeenCalled()
    expect(h.register).toHaveBeenCalled()
  })

  it('replaces a stale-key subscription and deletes its server row', async () => {
    // A stale-key row 403s at send time rather than 404/410, so the
    // server-side reap never clears it — it must be deleted explicitly
    // or every send fans out to both the dead and the live endpoint.
    const stale = fakeSubscription('https://push.example/stale', new Uint8Array([9, 9, 9]).buffer)
    const h = harness({ existing: stale })
    const resync = createPushResync(h.adapter)

    expect(await resync.sync()).toBe('resubscribed')
    expect(h.verify).not.toHaveBeenCalled()
    expect(stale.unsubscribe).toHaveBeenCalled()
    expect(h.unregister).toHaveBeenCalledWith('https://push.example/stale')
  })

  it('does nothing when the user has not opted in', async () => {
    const h = harness({ enabled: false, existing: null })
    const resync = createPushResync(h.adapter)

    expect(await resync.sync()).toBe('skipped')
    expect(h.subscribe).not.toHaveBeenCalled()
  })

  it('never prompts: does nothing without granted permission', async () => {
    const h = harness({ permission: 'default', existing: null })
    const resync = createPushResync(h.adapter)

    expect(await resync.sync()).toBe('skipped')
    expect(h.subscribe).not.toHaveBeenCalled()
  })

  describe('WebKit gesture refusal', () => {
    function refuseOnce() {
      const err = new Error('subscribe requires a user gesture')
      err.name = 'NotAllowedError'
      return err
    }

    it('marks itself blocked and arms a retry for the next tap', async () => {
      const err = refuseOnce()
      const h = harness({ existing: null, subscribeImpl: () => Promise.reject(err) })
      const resync = createPushResync(h.adapter)

      expect(await resync.sync()).toBe('blocked')
      expect(resync.isBlocked()).toBe(true)
      // Settings reads this marker to explain the silence.
      expect(h.store.get('testapp.pushResyncBlocked')).toBe('1')
      // A retry is waiting on the next interaction rather than giving up.
      expect((document.addEventListener as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]))
        .toEqual(expect.arrayContaining(['pointerup', 'click']))
    })

    it('never overlaps two subscribe() calls when the user taps twice', async () => {
      // A listener is re-armable the instant the previous one fires (so a
      // hung retry can't wedge the heal shut), so only the retry's own
      // single-flight stops two taps from racing two subscribes.
      const err = refuseOnce()
      let release: (() => void) | undefined
      let concurrent = 0
      let maxConcurrent = 0
      const subscribeImpl = vi
        .fn()
        // First call is the background attempt that gets refused.
        .mockImplementationOnce(() => Promise.reject(err))
        // Later calls are the gesture retries.
        .mockImplementation(async () => {
          concurrent += 1
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await new Promise<void>((resolve) => {
            release = resolve
          })
          concurrent -= 1
          return fakeSubscription('https://push.example/fresh')
        })
      const h = harness({ existing: null, subscribeImpl })
      const resync = createPushResync(h.adapter)

      expect(await resync.sync()).toBe('blocked')
      const handler = (document.addEventListener as ReturnType<typeof vi.fn>).mock
        .calls[0]![1] as () => void

      handler() // first tap → retry starts, parks on `release`
      handler() // second tap → must join the in-flight retry, not start another
      await Promise.resolve()

      expect(maxConcurrent).toBe(1)
      release?.()
    })

    it('clears the blocked marker once a heal finally lands', async () => {
      const h = harness({ existing: null })
      const resync = createPushResync(h.adapter)
      h.store.set('testapp.pushResyncBlocked', '1')

      expect(await resync.sync()).toBe('resubscribed')
      expect(resync.isBlocked()).toBe(false)
    })
  })

  it('reports failure rather than throwing when the key fetch fails', async () => {
    const h = harness({ existing: null })
    const resync = createPushResync({
      ...h.adapter,
      fetchImpl: vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch,
    })

    expect(await resync.sync()).toBe('failed')
    expect(h.subscribe).not.toHaveBeenCalled()
  })

  it('swallows an API error instead of breaking the caller', async () => {
    const h = harness({ existing: null })
    const resync = createPushResync({
      ...h.adapter,
      register: vi.fn().mockRejectedValue(new Error('500 from API')),
    })

    expect(await resync.sync()).toBe('failed')
  })

  describe('throttling', () => {
    it('runs the first time, then suppresses until the window elapses', async () => {
      const h = harness({ existing: fakeSubscription('https://push.example/live') })
      let clock = 1_700_000_000_000
      const resync = createPushResync({ ...h.adapter, now: () => clock })

      expect(await resync.maybeSync()).toBe('healthy')
      expect(await resync.maybeSync()).toBe('throttled')

      // An app-switch burst costs nothing…
      clock += 60_000
      expect(await resync.maybeSync()).toBe('throttled')

      // …but a genuinely stale window heals again.
      clock += 6 * 60 * 60 * 1000
      expect(await resync.maybeSync()).toBe('healthy')
      expect(h.verify).toHaveBeenCalledTimes(2)
    })

    it('stamps before running so a persistently-refused device backs off', async () => {
      const err = new Error('gesture required')
      err.name = 'NotAllowedError'
      const h = harness({ existing: null, subscribeImpl: () => Promise.reject(err) })
      const clock = 1_700_000_000_000
      const resync = createPushResync({ ...h.adapter, now: () => clock })

      expect(await resync.maybeSync()).toBe('blocked')
      // Without an attempt-based stamp this would retry on every single
      // visibilitychange for the whole window.
      expect(await resync.maybeSync()).toBe('throttled')
    })

    it('heals rather than wedging shut when the stored stamp is garbage', async () => {
      const h = harness({ existing: fakeSubscription('https://push.example/live') })
      const resync = createPushResync({ ...h.adapter, now: () => 1_700_000_000_000 })
      h.store.set('testapp.pushSyncAt', 'not-a-number')

      expect(await resync.maybeSync()).toBe('healthy')
    })

    it('scopes the throttle per user so a shared device does not carry state across sign-ins', async () => {
      const h = harness({ existing: fakeSubscription('https://push.example/live') })
      const clock = 1_700_000_000_000
      const resync = createPushResync({ ...h.adapter, now: () => clock })

      resync.setScope('user_a')
      expect(await resync.maybeSync()).toBe('healthy')
      expect(await resync.maybeSync()).toBe('throttled')

      // A different account signing in on the same device must get its
      // own first heal, not inherit user_a's window.
      resync.setScope('user_b')
      expect(await resync.maybeSync()).toBe('healthy')
    })

    it('keeps a run writing to the slots it started with when the user switches mid-heal', async () => {
      // An account switch landing between a heal's start and its tail
      // writes must not stamp the incoming user's throttle slot — that
      // would suppress their own first heal.
      let releaseVerify!: () => void
      let signalEntered!: () => void
      // Resolves once the run has actually reached verify(), so the
      // switch below lands mid-run rather than before it starts.
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve
      })
      const parked = new Promise<void>((resolve) => {
        releaseVerify = resolve
      })
      const h = harness({ existing: fakeSubscription('https://push.example/live') })
      const resync = createPushResync({
        ...h.adapter,
        now: () => 1_700_000_000_000,
        verify: vi.fn(async () => {
          signalEntered()
          await parked
          return true
        }),
      })

      resync.setScope('user_a')
      const running = resync.maybeSync()
      await entered
      resync.setScope('user_b') // switch while the verify is parked
      releaseVerify()
      await running

      // user_b's slot must be untouched, so their first heal still runs.
      expect(h.store.get('testapp.user_b.pushSyncAt')).toBeUndefined()
      expect(h.store.get('testapp.user_a.pushSyncAt')).toBe('1700000000000')
    })

    it('markSynced opens a fresh window and clears the blocked marker', async () => {
      const h = harness({ existing: fakeSubscription('https://push.example/live') })
      const clock = 1_700_000_000_000
      const resync = createPushResync({ ...h.adapter, now: () => clock })
      h.store.set('testapp.pushResyncBlocked', '1')

      resync.markSynced()
      expect(resync.isBlocked()).toBe(false)
      // The explicit toggle already did the work — don't redo it.
      expect(await resync.maybeSync()).toBe('throttled')
    })
  })

  it('shares one in-flight run between concurrent callers', async () => {
    // Mount and visibilitychange routinely fire together.
    const h = harness({ existing: fakeSubscription('https://push.example/live') })
    const resync = createPushResync(h.adapter)

    const [a, b] = await Promise.all([resync.sync(), resync.sync()])
    expect(a).toBe('healthy')
    expect(b).toBe('healthy')
    expect(h.verify).toHaveBeenCalledTimes(1)
  })
})
