import { describe, it, expect } from 'vitest'
import { signoutSession } from './signout-session.js'

function mockFetch(handler: (req: Request) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request
        ? input
        : new Request(typeof input === 'string' ? input : input.toString(), init)
    return handler(req)
  }) as typeof fetch
}

const BEARER = 'rps_live_x'.repeat(5)

describe('signoutSession', () => {
  it('posts the bearer to /api/v1/sdk/signout and returns ok on 200', async () => {
    let seenUrl = ''
    let seenAuth: string | null = null
    let seenMethod = ''
    const r = await signoutSession(BEARER, {
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch((req) => {
        seenUrl = req.url
        seenAuth = req.headers.get('authorization')
        seenMethod = req.method
        return new Response('{"ok":true}', { status: 200 })
      }),
    })
    expect(r.ok).toBe(true)
    expect(seenUrl).toBe('https://id.rallypt.app/api/v1/sdk/signout')
    expect(seenMethod).toBe('POST')
    expect(seenAuth).toBe(`Bearer ${BEARER}`)
  })

  it('strips a trailing slash from apiBase', async () => {
    let seenUrl = ''
    await signoutSession(BEARER, {
      apiBase: 'https://id.rallypt.app/',
      fetchImpl: mockFetch((req) => {
        seenUrl = req.url
        return new Response('{"ok":true}', { status: 200 })
      }),
    })
    expect(seenUrl).toBe('https://id.rallypt.app/api/v1/sdk/signout')
  })

  it('reports transport_error on a non-200 response', async () => {
    const r = await signoutSession(BEARER, {
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => new Response('boom', { status: 502 })),
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('transport_error')
  })

  it('reports transport_error when fetch itself throws', async () => {
    const r = await signoutSession(BEARER, {
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => {
        throw new Error('network gone')
      }),
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('transport_error')
  })

  it('reports transport_error for an empty bearer without calling fetch', async () => {
    let called = false
    const r = await signoutSession('', {
      apiBase: 'https://id.rallypt.app',
      fetchImpl: mockFetch(() => {
        called = true
        return new Response('{"ok":true}', { status: 200 })
      }),
    })
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })
})
