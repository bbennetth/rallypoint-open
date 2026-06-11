import { describe, it, expect } from 'vitest'
import { getSettings, patchSettings, SettingsError } from './settings.js'
import type { UserId } from './types.js'

function mockFetch(handler: (req: Request) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request
        ? input
        : new Request(typeof input === 'string' ? input : input.toString(), init)
    return handler(req)
  }) as typeof fetch
}

const BASE = 'https://id.rallypt.app'
const KEY = 'planner-api-key-32chars-minimum-aaaa'
const USER = 'user_01HXTEST' as UserId

describe('getSettings', () => {
  it('GETs the namespaced URL with bearer + x-actor and returns the doc', async () => {
    let url = ''
    let auth: string | null = null
    let actor: string | null = null
    let method = ''
    const doc = await getSettings({
      baseUrl: BASE,
      apiKey: KEY,
      userId: USER,
      namespace: 'shared',
      fetch: mockFetch((req) => {
        url = req.url
        auth = req.headers.get('authorization')
        actor = req.headers.get('x-actor')
        method = req.method
        return new Response(JSON.stringify({ settings: { themeMode: 'dark' } }), { status: 200 })
      }),
    })
    expect(url).toBe(`${BASE}/api/v1/sdk/settings/shared`)
    expect(auth).toBe(`Bearer ${KEY}`)
    expect(actor).toBe(USER)
    expect(method).toBe('GET')
    expect(doc).toEqual({ themeMode: 'dark' })
  })

  it('returns {} when the response omits settings', async () => {
    const doc = await getSettings({
      baseUrl: BASE,
      apiKey: KEY,
      userId: USER,
      namespace: 'shared',
      fetch: mockFetch(() => new Response('{}', { status: 200 })),
    })
    expect(doc).toEqual({})
  })

  it('throws SettingsError carrying the envelope code on non-2xx', async () => {
    await expect(
      getSettings({
        baseUrl: BASE,
        apiKey: KEY,
        userId: USER,
        namespace: 'events',
        fetch: mockFetch(
          () => new Response(JSON.stringify({ error: { code: 'forbidden' } }), { status: 403 }),
        ),
      }),
    ).rejects.toMatchObject({ name: 'SettingsError', status: 403, code: 'forbidden' })
  })
})

describe('patchSettings', () => {
  it('PATCHes the patch body and returns the merged doc', async () => {
    let method = ''
    let body = ''
    const merged = await patchSettings({
      baseUrl: BASE,
      apiKey: KEY,
      userId: USER,
      namespace: 'shared',
      patch: { themeColor: 'pink' },
      fetch: mockFetch(async (req) => {
        method = req.method
        body = await req.text()
        return new Response(JSON.stringify({ settings: { themeColor: 'pink' } }), { status: 200 })
      }),
    })
    expect(method).toBe('PATCH')
    expect(JSON.parse(body)).toEqual({ themeColor: 'pink' })
    expect(merged).toEqual({ themeColor: 'pink' })
  })

  it('encodes the namespace path segment', async () => {
    let url = ''
    await patchSettings({
      baseUrl: BASE,
      apiKey: KEY,
      userId: USER,
      namespace: 'a/b',
      patch: {},
      fetch: mockFetch((req) => {
        url = req.url
        return new Response('{"settings":{}}', { status: 200 })
      }),
    })
    expect(url).toBe(`${BASE}/api/v1/sdk/settings/a%2Fb`)
  })

  it('is exported as a SettingsError class', () => {
    expect(new SettingsError(400, 'x', 'y')).toBeInstanceOf(Error)
  })
})
