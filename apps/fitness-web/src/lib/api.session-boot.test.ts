// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'

// Instant boot: with a cached SessionDto, getSession resolves
// immediately from IndexedDB and revalidates in the background — 401
// fires SESSION_REVOKED_EVENT, a transport failure keeps the cached UI,
// and a cold cache still blocks on the network probe like before.

let sessionResponse: () => Response = () => ok({ user_id: 'user_A' })

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const probeCalls: string[] = []

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input)
  const method = init?.method ?? 'GET'
  if (method === 'GET' && path.endsWith('/csrf')) return ok({ csrfToken: 't' })
  if (method === 'GET' && path.endsWith('/session')) {
    probeCalls.push(path)
    return sessionResponse()
  }
  if (method === 'GET') return ok({})
  return ok({})
})

let api: typeof import('./api.js')
let cache: typeof import('./offline/cache.js')

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub)
  api = await import('./api.js')
  cache = await import('./offline/cache.js')
})

const UID = 'user_A'

beforeEach(() => {
  cache.setOfflineUser(UID)
  probeCalls.length = 0
  sessionResponse = () => ok({ user_id: UID })
})

afterEach(async () => {
  cache.setOfflineUser(null)
  for (const name of [UID, 'user_B']) {
    try {
      await Dexie.delete(`fitness-offline:${name}`)
    } catch {
      // ignore
    }
  }
})

describe('getSession — instant boot from cached session', () => {
  it('resolves from the cache without waiting for the network probe', async () => {
    await cache.writeSession('current', { user_id: UID })
    // Make the probe hang — the cached path must not await it.
    let resolveProbe: (r: Response) => void = () => {}
    const hang = new Promise<Response>((r) => {
      resolveProbe = r
    })
    fetchStub.mockImplementationOnce(async (input, init) => {
      const path = String(input)
      if ((init?.method ?? 'GET') === 'GET' && path.endsWith('/session')) return hang
      return ok({})
    })

    const session = await api.getSession()
    expect(session.user_id).toBe(UID)
    resolveProbe(ok({ user_id: UID }))
  })

  it('hydrates the default-rest preference from app_settings', async () => {
    const { getDefaultRestS } = await import('./rest-settings.js')
    await cache.writeSession('current', { user_id: UID })
    sessionResponse = () => ok({ user_id: UID, app_settings: { defaultRestS: 150 } })

    await api.getSession()
    await vi.waitFor(() => expect(getDefaultRestS()).toBe(150))
  })

  it('background revalidation refreshes the cached session (settings fold-in included)', async () => {
    await cache.writeSession('current', { user_id: UID })
    sessionResponse = () =>
      ok({ user_id: UID, app_settings: { weightUnit: 'kg' }, settings: { themeMode: 'dark' } })

    await api.getSession()
    await vi.waitFor(() => expect(probeCalls.length).toBeGreaterThan(0))
    await vi.waitFor(async () => {
      const stored = await cache.readSession<{ settings?: unknown }>('current')
      expect(stored?.settings).toEqual({ themeMode: 'dark' })
    })
  })

  it('revalidation 401 dispatches SESSION_REVOKED_EVENT', async () => {
    await cache.writeSession('current', { user_id: UID })
    sessionResponse = () => ok({ error: { code: 'unauthorized' } }, 401)
    const revoked = vi.fn()
    window.addEventListener(api.SESSION_REVOKED_EVENT, revoked)

    const session = await api.getSession() // still resolves from cache
    expect(session.user_id).toBe(UID)
    await vi.waitFor(() => expect(revoked).toHaveBeenCalled())
    window.removeEventListener(api.SESSION_REVOKED_EVENT, revoked)
  })

  it('revalidation transport failure keeps the cached UI (no revoke event)', async () => {
    await cache.writeSession('current', { user_id: UID })
    sessionResponse = () => {
      throw new Error('network down')
    }
    const revoked = vi.fn()
    window.addEventListener(api.SESSION_REVOKED_EVENT, revoked)

    const session = await api.getSession()
    expect(session.user_id).toBe(UID)
    await vi.waitFor(() => expect(probeCalls.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 20))
    expect(revoked).not.toHaveBeenCalled()
    window.removeEventListener(api.SESSION_REVOKED_EVENT, revoked)
  })

  it('revalidation user-id mismatch purges the stale user and reloads', async () => {
    await cache.writeSession('current', { user_id: UID })
    sessionResponse = () => ok({ user_id: 'user_B' })
    // jsdom's location.reload throws "Not implemented" — replace it.
    const reload = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    })

    try {
      const session = await api.getSession() // resolves from user_A's cache
      expect(session.user_id).toBe(UID)
      await vi.waitFor(() => expect(reload).toHaveBeenCalled())

      // user_A's offline DB is gone; the new session is persisted under
      // user_B so the post-reload boot takes the instant path as user_B.
      const dbs = await indexedDB.databases()
      const names = dbs.map((d) => d.name)
      expect(names).not.toContain(`fitness-offline:${UID}`)
      const stored = await cache.readSession<{ user_id: string }>('current')
      expect(stored?.user_id).toBe('user_B')
    } finally {
      // Exception-safe restore — a failed assertion must not leave the
      // location stub in place for the rest of the file.
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })

  it('cold cache blocks on the probe and surfaces a 401', async () => {
    sessionResponse = () => ok({ error: { code: 'unauthorized' } }, 401)
    await expect(api.getSession()).rejects.toMatchObject({ status: 401 })
  })

  it('cold cache success stores the session for the next boot', async () => {
    sessionResponse = () => ok({ user_id: UID })
    const session = await api.getSession()
    expect(session.user_id).toBe(UID)
    const stored = await cache.readSession<{ user_id: string }>('current')
    expect(stored?.user_id).toBe(UID)
  })
})
