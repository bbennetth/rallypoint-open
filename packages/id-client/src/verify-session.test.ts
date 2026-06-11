import { describe, it, expect, vi } from 'vitest'
import { SessionVerifier, verifySessionOnce } from './verify-session.js'
import type { UserInfo } from './types.js'

const USER: UserInfo = {
  sub: 'user_01HXTEST00000000000000000A',
  email: 'alice@example.com',
  email_verified: true,
  preferred_username: 'alice',
  name: 'Alice',
  picture: null,
  updated_at: new Date().toISOString(),
}

function mockFetch(handler: (req: Request) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request
        ? input
        : new Request(typeof input === 'string' ? input : input.toString(), init)
    return handler(req)
  }) as typeof fetch
}

describe('SessionVerifier.verifySession', () => {
  it('returns ok+user on a 200 response', async () => {
    const v = new SessionVerifier({
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => new Response(JSON.stringify(USER), { status: 200 })),
    })
    const r = await v.verifySession('rps_live_x'.repeat(5))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.user.sub).toBe(USER.sub)
  })

  it('returns invalid on 401', async () => {
    const v = new SessionVerifier({
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => new Response('{"error":{"code":"bearer_invalid"}}', { status: 401 })),
    })
    const r = await v.verifySession('rps_live_x'.repeat(5))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid')
  })

  it('returns transport_error on 5xx', async () => {
    const v = new SessionVerifier({
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => new Response('boom', { status: 502 })),
    })
    const r = await v.verifySession('rps_live_x'.repeat(5))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('transport_error')
  })

  it('returns transport_error when fetch itself throws', async () => {
    const v = new SessionVerifier({
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => {
        throw new Error('network gone')
      }),
    })
    const r = await v.verifySession('rps_live_x'.repeat(5))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('transport_error')
  })

  it('rejects empty token without hitting the network', async () => {
    const spy = vi.fn()
    const v = new SessionVerifier({
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => {
        spy()
        return new Response()
      }),
    })
    const r = await v.verifySession('')
    expect(r.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('caches successful results within the TTL', async () => {
    let calls = 0
    const v = new SessionVerifier({
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => {
        calls++
        return new Response(JSON.stringify(USER), { status: 200 })
      }),
    })
    const t = 'rps_live_x'.repeat(5)
    await v.verifySession(t)
    await v.verifySession(t)
    await v.verifySession(t)
    expect(calls).toBe(1)
  })

  it('does NOT cache transport errors (retries on next call)', async () => {
    const results = [
      new Response('boom', { status: 503 }),
      new Response(JSON.stringify(USER), { status: 200 }),
    ]
    let i = 0
    const v = new SessionVerifier({
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => results[i++]!),
    })
    const t = 'rps_live_x'.repeat(5)
    const first = await v.verifySession(t)
    expect(first.ok).toBe(false)
    const second = await v.verifySession(t)
    expect(second.ok).toBe(true)
  })

  it('caches 401s within the TTL (intentional — stops a brute-forcer from amplifying)', async () => {
    let calls = 0
    const v = new SessionVerifier({
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => {
        calls++
        return new Response('{"error":{"code":"bearer_invalid"}}', { status: 401 })
      }),
    })
    await v.verifySession('rps_live_bad'.repeat(5))
    await v.verifySession('rps_live_bad'.repeat(5))
    expect(calls).toBe(1)
  })

  it('invalidateAll clears the cache', async () => {
    let calls = 0
    const v = new SessionVerifier({
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => {
        calls++
        return new Response(JSON.stringify(USER), { status: 200 })
      }),
    })
    await v.verifySession('rps_live_x'.repeat(5))
    v.invalidateAll()
    await v.verifySession('rps_live_x'.repeat(5))
    expect(calls).toBe(2)
  })

  it('evicts the oldest entry when cacheCapacity is exceeded (#39)', async () => {
    let calls = 0
    const v = new SessionVerifier({
      apiBase: 'https://id.rallypt.app',
      cacheCapacity: 2,
      fetchImpl: mockFetch(() => {
        calls++
        return new Response(JSON.stringify(USER), { status: 200 })
      }),
    })
    const A = 'rps_live_a'.repeat(5)
    const B = 'rps_live_b'.repeat(5)
    const C = 'rps_live_c'.repeat(5)
    await v.verifySession(A) // 1st call
    await v.verifySession(B) // 2nd call
    await v.verifySession(C) // 3rd call — evicts A
    // B + C are cached; A was evicted.
    await v.verifySession(B) // cached, no call
    await v.verifySession(C) // cached, no call
    await v.verifySession(A) // 4th call — A was evicted
    expect(calls).toBe(4)
  })
})

describe('verifySessionOnce', () => {
  it('works without holding an instance', async () => {
    const r = await verifySessionOnce('rps_live_x'.repeat(5), {
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => new Response(JSON.stringify(USER), { status: 200 })),
    })
    expect(r.ok).toBe(true)
  })
})
