import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock @rallypoint/ui at module scope (vi.mock is only hoisted from the top
// level, not from inside an `it`). The hoisted spy lets the hydration tests
// assert how getSession folds the shared settings doc into the theme store.
const { hydrateThemeSpy } = vi.hoisted(() => ({ hydrateThemeSpy: vi.fn() }))
vi.mock('@rallypoint/ui', () => ({ hydrateThemeFromServer: hydrateThemeSpy }))

// The api module caches csrfToken at module scope. We reset modules between
// tests that care about CSRF state so each gets a clean cache.

type FetchMock = ReturnType<typeof vi.fn>

function makeFetch(queue: Array<Partial<Response>>): FetchMock {
  const fn = vi.fn()
  for (const r of queue) {
    fn.mockResolvedValueOnce(r as Response)
  }
  return fn
}

function jsonResp(body: unknown, status = 200): Partial<Response> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() {
      return this as Response
    },
  }
}


describe('GET requests', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('listEvents sends credentials:include and Accept:application/json', async () => {
    const fetchMock = makeFetch([
      jsonResp({ items: [], next_cursor: null }),
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { listEvents } = await import('./api.js')
    await listEvents()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/ui/events',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    )
  })
})

describe('POST requests (CSRF bootstrap)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('createEvent GETs /csrf first then POSTs with X-RP-CSRF and Content-Type', async () => {
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'tok123' }),
      jsonResp({ id: 'event_1', slug: 'my-event', name: 'My Event',
        description: null, start_date: null, end_date: null,
        timezone: 'UTC', location_label: null, location_lat: null,
        location_lng: null, privacy_mode: 'public', owner_user_id: 'u1',
        viewer_role: 'owner', created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), deleted_at: null }, 201),
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { createEvent } = await import('./api.js')
    await createEvent({ name: 'My Event', timezone: 'UTC' })

    expect(fetchMock).toHaveBeenCalledTimes(2)

    // First call: CSRF bootstrap
    const [csrfUrl, csrfOpts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(csrfUrl).toBe('/api/v1/ui/csrf')
    expect(csrfOpts.credentials).toBe('include')

    // Second call: the mutation
    const [mutUrl, mutOpts] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(mutUrl).toBe('/api/v1/ui/events')
    expect((mutOpts.headers as Record<string, string>)['X-RP-CSRF']).toBe('tok123')
    expect((mutOpts.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
})

describe('DELETE / 204 response', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('deleteEvent with 204 resolves to undefined without parsing JSON', async () => {
    const jsonSpy = vi.fn()
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'tok' }),
      { ok: true, status: 204, json: jsonSpy },
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { deleteEvent } = await import('./api.js')
    const result = await deleteEvent('event_1')

    expect(result).toBeUndefined()
    expect(jsonSpy).not.toHaveBeenCalled()
  })
})

describe('Error parsing', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('throws ApiError with correct code and status on non-2xx with error body', async () => {
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'tok' }),
      {
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'slug_taken', message: 'Slug taken.' } }),
        clone() { return this as unknown as Response },
      } as Partial<Response>,
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { createEvent, ApiError } = await import('./api.js')
    const err = await createEvent({ name: 'X', timezone: 'UTC' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as InstanceType<typeof ApiError>).code).toBe('slug_taken')
    expect((err as InstanceType<typeof ApiError>).status).toBe(409)
  })
})

describe('CSRF retry path', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('retries mutation after a 403 csrf_token_invalid by re-fetching /csrf', async () => {
    const eventBody = {
      id: 'event_1', slug: 'ev', name: 'Ev', description: null,
      start_date: null, end_date: null, timezone: 'UTC',
      location_label: null, location_lat: null, location_lng: null,
      privacy_mode: 'public', owner_user_id: 'u1', viewer_role: 'owner',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      deleted_at: null,
    }

    // Call sequence:
    // 1. GET /csrf  → csrfToken:'stale'
    // 2. POST /events → 403 csrf_token_invalid
    // 3. GET /csrf (re-bootstrap) → csrfToken:'fresh'
    // 4. POST /events (retry) → 201 ok
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'stale' }),
      {
        ok: false,
        status: 403,
        json: async () => ({ error: { code: 'csrf_token_invalid', message: 'stale' } }),
        clone() { return this as unknown as Response },
      } as Partial<Response>,
      jsonResp({ csrfToken: 'fresh' }),
      jsonResp(eventBody, 201),
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { createEvent } = await import('./api.js')
    const result = await createEvent({ name: 'Ev', timezone: 'UTC' })

    expect(fetchMock).toHaveBeenCalledTimes(4)

    // Third call should be the CSRF re-fetch
    const [thirdUrl] = fetchMock.mock.calls[2] as [string]
    expect(thirdUrl).toBe('/api/v1/ui/csrf')

    // Fourth call should use the fresh token
    const [, fourthOpts] = fetchMock.mock.calls[3] as [string, RequestInit]
    expect((fourthOpts.headers as Record<string, string>)['X-RP-CSRF']).toBe('fresh')

    expect(result.slug).toBe('ev')
  })
})

describe('listEvents query-string building', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('passes includeDeleted, limit, and cursor as query params', async () => {
    const fetchMock = makeFetch([
      jsonResp({ items: [], next_cursor: null }),
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { listEvents } = await import('./api.js')
    await listEvents({ includeDeleted: true, limit: 5, cursor: 'c1' })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('include=deleted')
    expect(url).toContain('limit=5')
    expect(url).toContain('cursor=c1')
  })
})

describe('getEvent slug encoding', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('encodes slugs with spaces in the URL path', async () => {
    const fetchMock = makeFetch([
      jsonResp({
        id: 'e1', slug: 'a b', name: 'A B', description: null,
        start_date: null, end_date: null, timezone: 'UTC',
        location_label: null, location_lat: null, location_lng: null,
        privacy_mode: 'public', owner_user_id: 'u1', viewer_role: 'viewer',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        deleted_at: null,
      }),
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { getEvent } = await import('./api.js')
    await getEvent('a b')

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('a%20b')
  })
})

describe('getSession theme hydration', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
    hydrateThemeSpy.mockClear()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('calls hydrateThemeFromServer when the session response includes a settings doc', async () => {
    const fetchMock = makeFetch([
      jsonResp({
        user_id: 'user_abc',
        settings: { themeMode: 'dark', themeColor: 'violet' },
      }),
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { getSession } = await import('./api.js')
    const session = await getSession()

    expect(session.user_id).toBe('user_abc')
    expect(hydrateThemeSpy).toHaveBeenCalledWith({
      mode: 'dark',
      color: 'violet',
    })
  })

  it('does not call hydrateThemeFromServer when the session has no settings', async () => {
    const fetchMock = makeFetch([
      jsonResp({ user_id: 'user_xyz' }),
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { getSession } = await import('./api.js')
    await getSession()

    expect(hydrateThemeSpy).not.toHaveBeenCalled()
  })
})
