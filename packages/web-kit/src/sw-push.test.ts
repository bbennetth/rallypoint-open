import { describe, expect, it, vi } from 'vitest'
import {
  endpointToRemove,
  handlePushSubscriptionChange,
  subscriptionPayload,
  urlBase64ToUint8Array,
} from './sw-push.js'

const FULL = {
  endpoint: 'https://web.push.apple.com/abc',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
}

describe('subscriptionPayload', () => {
  it('narrows a complete subscription', () => {
    expect(subscriptionPayload(FULL)).toEqual({
      endpoint: 'https://web.push.apple.com/abc',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    })
  })

  it('rejects a subscription missing any required field', () => {
    expect(subscriptionPayload({ ...FULL, endpoint: undefined })).toBeNull()
    expect(subscriptionPayload({ ...FULL, keys: undefined })).toBeNull()
    expect(subscriptionPayload({ ...FULL, keys: { auth: 'auth-value' } })).toBeNull()
    expect(subscriptionPayload({ ...FULL, keys: { p256dh: 'p256dh-value' } })).toBeNull()
  })

  it('rejects nothing at all', () => {
    expect(subscriptionPayload(null)).toBeNull()
    expect(subscriptionPayload(undefined)).toBeNull()
  })
})

describe('endpointToRemove', () => {
  it('has nothing to remove without an old endpoint', () => {
    expect(endpointToRemove(null, 'https://new')).toBeNull()
    expect(endpointToRemove(undefined, 'https://new')).toBeNull()
    expect(endpointToRemove('', 'https://new')).toBeNull()
  })

  it('never removes the endpoint we just registered', () => {
    // Same endpoint = an in-place upsert; deleting it would drop the
    // live row we just wrote.
    expect(endpointToRemove('https://same', 'https://same')).toBeNull()
  })

  it('removes a genuinely replaced endpoint', () => {
    expect(endpointToRemove('https://old', 'https://new')).toBe('https://old')
  })
})

// The SW half of the fix — what Chrome/FCM users actually rely on when
// the push service rotates a subscription. All of it is best-effort by
// design (a worker has no UI to fail into), so these assert that it
// never throws AND that it stops rather than sending a broken request.
describe('handlePushSubscriptionChange', () => {
  const FRESH = 'https://web.push.apple.com/fresh'

  function subscription(endpoint: string) {
    return {
      endpoint,
      options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
      toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    } as unknown as PushSubscription
  }

  // Routes each URL to a canned response; records every call.
  function fakeFetch(
    handlers: Record<string, { ok: boolean; body?: unknown }>,
    onCall?: (url: string, init?: RequestInit) => void,
  ) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      onCall?.(url, init)
      const match = Object.keys(handlers).find((k) => url.includes(k))
      const res = match ? handlers[match]! : { ok: false }
      return {
        ok: res.ok,
        status: res.ok ? 200 : 500,
        json: async () => res.body ?? {},
      } as Response
    }) as unknown as typeof fetch
  }

  const registration = {
    pushManager: { subscribe: vi.fn().mockResolvedValue(subscription(FRESH)) },
  } as unknown as ServiceWorkerRegistration

  it('registers the replacement the browser already made, with the CSRF token echoed', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = fakeFetch(
      {
        '/api/v1/ui/csrf': { ok: true, body: { csrfToken: 'tok-123' } },
        '/api/v1/ui/push/subscription': { ok: true },
      },
      (url, init) => calls.push({ url, init }),
    )

    const result = await handlePushSubscriptionChange({
      registration,
      oldSubscription: subscription('https://web.push.apple.com/old'),
      newSubscription: subscription(FRESH),
      fetchImpl,
    })

    expect(result).toBe(FRESH)
    const post = calls.find((c) => c.init?.method === 'POST')!
    // The double-submit half the server checks — without it every SW
    // re-registration would 403 and the rotation would go unhealed.
    expect((post.init?.headers as Record<string, string>)['X-RP-CSRF']).toBe('tok-123')
    expect(post.init?.credentials).toBe('include')
    expect(JSON.parse(post.init?.body as string)).toEqual({
      endpoint: FRESH,
      keys: { p256dh: 'p', auth: 'a' },
    })
  })

  it('deletes the replaced endpoint only when it actually differs', async () => {
    const deletes: string[] = []
    const record = (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') deletes.push(JSON.parse(init.body as string).endpoint)
    }
    const handlers = {
      '/api/v1/ui/csrf': { ok: true, body: { csrfToken: 't' } },
      '/api/v1/ui/push/subscription': { ok: true },
    }

    await handlePushSubscriptionChange({
      registration,
      oldSubscription: subscription('https://web.push.apple.com/old'),
      newSubscription: subscription(FRESH),
      fetchImpl: fakeFetch(handlers, record),
    })
    expect(deletes).toEqual(['https://web.push.apple.com/old'])

    // Same endpoint re-registered = an in-place upsert; deleting it would
    // drop the live row we just wrote.
    deletes.length = 0
    await handlePushSubscriptionChange({
      registration,
      oldSubscription: subscription(FRESH),
      newSubscription: subscription(FRESH),
      fetchImpl: fakeFetch(handlers, record),
    })
    expect(deletes).toEqual([])
  })

  it('subscribes itself when the browser supplies no replacement', async () => {
    const subscribe = vi.fn().mockResolvedValue(subscription(FRESH))
    const result = await handlePushSubscriptionChange({
      registration: { pushManager: { subscribe } } as unknown as ServiceWorkerRegistration,
      oldSubscription: subscription('https://web.push.apple.com/old'),
      newSubscription: null,
      fetchImpl: fakeFetch({
        '/api/v1/ui/csrf': { ok: true, body: { csrfToken: 't' } },
        '/api/v1/ui/push/subscription': { ok: true },
      }),
    })
    expect(result).toBe(FRESH)
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    )
  })

  it('gives up quietly when the CSRF bootstrap fails, without POSTing', async () => {
    const calls: string[] = []
    const result = await handlePushSubscriptionChange({
      registration,
      newSubscription: subscription(FRESH),
      fetchImpl: fakeFetch({ '/api/v1/ui/csrf': { ok: false } }, (_u, init) => {
        if (init?.method) calls.push(init.method)
      }),
    })
    expect(result).toBeNull()
    expect(calls).not.toContain('POST')
  })

  it('gives up quietly when the register POST is rejected (e.g. no session in the worker)', async () => {
    const result = await handlePushSubscriptionChange({
      registration,
      newSubscription: subscription(FRESH),
      fetchImpl: fakeFetch({
        '/api/v1/ui/csrf': { ok: true, body: { csrfToken: 't' } },
        '/api/v1/ui/push/subscription': { ok: false },
      }),
    })
    // The page-side heal re-registers on the next launch.
    expect(result).toBeNull()
  })

  it('never throws when the network is gone', async () => {
    const result = await handlePushSubscriptionChange({
      registration,
      newSubscription: subscription(FRESH),
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
    })
    expect(result).toBeNull()
  })

  it('stops when it has neither a replacement nor a key to subscribe with', async () => {
    const subscribe = vi.fn()
    const result = await handlePushSubscriptionChange({
      registration: { pushManager: { subscribe } } as unknown as ServiceWorkerRegistration,
      oldSubscription: null,
      newSubscription: null,
      // No publicKey in the response → nothing to subscribe with.
      fetchImpl: fakeFetch({ '/api/v1/push/public-key': { ok: true, body: {} } }),
    })
    expect(result).toBeNull()
    expect(subscribe).not.toHaveBeenCalled()
  })
})

describe('urlBase64ToUint8Array', () => {
  it('decodes unpadded base64url into the raw key bytes', () => {
    // "Hello" → SGVsbG8 (base64url, padding stripped).
    expect(Array.from(urlBase64ToUint8Array('SGVsbG8'))).toEqual([72, 101, 108, 108, 111])
  })

  it('decodes the url-safe alphabet (- and _)', () => {
    // Bytes 0xFB 0xFF map to "-_8" once url-safe-encoded.
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255])
  })
})
