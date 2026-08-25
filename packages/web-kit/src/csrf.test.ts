import { describe, it, expect, vi } from 'vitest'
import { createCsrfClient, ApiError } from './csrf.js'

type FetchMock = ReturnType<typeof vi.fn>

function makeFetch(queue: Array<Partial<Response>>): FetchMock {
  const fn = vi.fn()
  for (const r of queue) fn.mockResolvedValueOnce(r as Response)
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

describe('createCsrfClient — GET', () => {
  it('sends credentials:include + Accept, no CSRF header', async () => {
    const fetchMock = makeFetch([jsonResp({ items: [] })])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.request('GET', '/api/v1/ui/events')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/ui/events',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    )
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)['X-RP-CSRF']).toBeUndefined()
  })
})

describe('createCsrfClient — PostHog session header', () => {
  it('sends X-POSTHOG-SESSION-ID on GETs when a session id is available', async () => {
    const fetchMock = makeFetch([jsonResp({ items: [] })])
    const client = createCsrfClient({
      fetchImpl: fetchMock as unknown as typeof fetch,
      sessionIdProvider: () => 'sess_abc',
    })

    await client.request('GET', '/api/v1/ui/events')

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)['X-POSTHOG-SESSION-ID']).toBe('sess_abc')
  })

  it('sends it on mutations alongside the CSRF header', async () => {
    const fetchMock = makeFetch([jsonResp({ csrfToken: 'tok' }), jsonResp({}, 201)])
    const client = createCsrfClient({
      fetchImpl: fetchMock as unknown as typeof fetch,
      sessionIdProvider: () => 'sess_abc',
    })

    await client.request('POST', '/api/v1/ui/events', { name: 'X' })

    const [, mutOpts] = fetchMock.mock.calls[1] as [string, RequestInit]
    const headers = mutOpts.headers as Record<string, string>
    expect(headers['X-POSTHOG-SESSION-ID']).toBe('sess_abc')
    expect(headers['X-RP-CSRF']).toBe('tok')
  })

  it('omits the header when no session id is available (default noop path)', async () => {
    // No sessionIdProvider — falls through to the analytics seam, which the
    // vitest alias resolves to the FOSS noop (getSessionId → undefined).
    const fetchMock = makeFetch([jsonResp({ items: [] })])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.request('GET', '/api/v1/ui/events')

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)['X-POSTHOG-SESSION-ID']).toBeUndefined()
  })
})

describe('createCsrfClient — CSRF bootstrap', () => {
  it('GETs /csrf first, then echoes the token on the mutation', async () => {
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'tok123' }),
      jsonResp({ id: 'x' }, 201),
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.request('POST', '/api/v1/ui/events', { name: 'X' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [csrfUrl] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(csrfUrl).toBe('/api/v1/ui/csrf')
    const [, mutOpts] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect((mutOpts.headers as Record<string, string>)['X-RP-CSRF']).toBe('tok123')
    expect((mutOpts.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('caches the token across mutations (bootstraps once)', async () => {
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'tok' }),
      jsonResp({}, 201),
      jsonResp({}, 201),
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.request('POST', '/api/v1/ui/a')
    await client.request('POST', '/api/v1/ui/b')

    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 csrf + 2 mutations
  })

  it('single-flights the CSRF fetch when concurrent mutations race with no token', async () => {
    // Only one /csrf response in the queue — if both mutations fire their own
    // fetchCsrf() simultaneously the second would hang (no response queued).
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'shared' }),
      jsonResp({}, 201),
      jsonResp({}, 201),
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    // Fire two mutations before the CSRF token has been fetched.
    await Promise.all([
      client.request('POST', '/api/v1/ui/a'),
      client.request('POST', '/api/v1/ui/b'),
    ])

    // Only one CSRF fetch despite two concurrent callers.
    const csrfCalls = fetchMock.mock.calls.filter(([url]: [string]) => (url as string).endsWith('/csrf'))
    expect(csrfCalls).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 csrf + 2 mutations
  })

  it('honours a custom basePath + csrfHeader', async () => {
    const fetchMock = makeFetch([jsonResp({ csrfToken: 't' }), jsonResp({}, 201)])
    const client = createCsrfClient({
      basePath: '/api/v2/bff',
      csrfHeader: 'X-CSRF',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await client.request('POST', '/api/v2/bff/thing')

    const [csrfUrl] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(csrfUrl).toBe('/api/v2/bff/csrf')
    const [, mutOpts] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect((mutOpts.headers as Record<string, string>)['X-CSRF']).toBe('t')
  })

  it('refetches the token once on a csrf_token_invalid 403 then retries', async () => {
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'stale' }),
      {
        ok: false,
        status: 403,
        json: async () => ({ error: { code: 'csrf_token_invalid' } }),
        clone() {
          return this as unknown as Response
        },
      } as Partial<Response>,
      jsonResp({ csrfToken: 'fresh' }),
      jsonResp({}, 200),
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.request('POST', '/api/v1/ui/thing')

    expect(fetchMock).toHaveBeenCalledTimes(4)
    const [, retryOpts] = fetchMock.mock.calls[3] as [string, RequestInit]
    expect((retryOpts.headers as Record<string, string>)['X-RP-CSRF']).toBe('fresh')
  })

  it('does NOT retry on a 403 that is not csrf_token_invalid', async () => {
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'tok' }),
      {
        ok: false,
        status: 403,
        json: async () => ({ error: { code: 'forbidden' } }),
        clone() {
          return this as unknown as Response
        },
      } as Partial<Response>,
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const err = await client.request('POST', '/api/v1/ui/thing').catch((e: unknown) => e)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(403)
    expect((err as ApiError).code).toBe('forbidden')
  })
})

describe('createCsrfClient — responses', () => {
  it('returns undefined on 204 without parsing JSON', async () => {
    const jsonSpy = vi.fn()
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'tok' }),
      { ok: true, status: 204, json: jsonSpy },
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const result = await client.request('DELETE', '/api/v1/ui/thing/1')

    expect(result).toBeUndefined()
    expect(jsonSpy).not.toHaveBeenCalled()
  })

  it('throws ApiError with code + status on a non-2xx error body', async () => {
    const fetchMock = makeFetch([
      {
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'slug_taken', message: 'Slug taken.' } }),
        clone() {
          return this as unknown as Response
        },
      } as Partial<Response>,
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const err = await client.request('GET', '/api/v1/ui/events').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('slug_taken')
    expect((err as ApiError).status).toBe(409)
  })

  it('preserves the error envelope\'s `details` onto ApiError.detail', async () => {
    const fetchMock = makeFetch([
      {
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'validation_failed',
            message: 'Request body failed validation.',
            details: { issues: [{ path: 'sets.0.reps', message: 'must be a number' }] },
          },
        }),
        clone() {
          return this as unknown as Response
        },
      } as Partial<Response>,
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const err = await client.request('POST', '/api/v1/ui/workouts').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).detail).toEqual({
      issues: [{ path: 'sets.0.reps', message: 'must be a number' }],
    })
  })

  it('leaves ApiError.detail undefined when the envelope has no `details`', async () => {
    const fetchMock = makeFetch([
      {
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'slug_taken', message: 'Slug taken.' } }),
        clone() {
          return this as unknown as Response
        },
      } as Partial<Response>,
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const err = await client.request('GET', '/api/v1/ui/events').catch((e: unknown) => e)

    expect((err as ApiError).detail).toBeUndefined()
  })

  it('resetCsrf forces a re-bootstrap on the next mutation', async () => {
    const fetchMock = makeFetch([
      jsonResp({ csrfToken: 'tok1' }),
      jsonResp({}, 201),
      jsonResp({ csrfToken: 'tok2' }),
      jsonResp({}, 201),
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.request('POST', '/api/v1/ui/a')
    client.resetCsrf()
    await client.request('POST', '/api/v1/ui/b')

    expect(fetchMock).toHaveBeenCalledTimes(4)
    const [, secondMut] = fetchMock.mock.calls[3] as [string, RequestInit]
    expect((secondMut.headers as Record<string, string>)['X-RP-CSRF']).toBe('tok2')
  })
})

describe('createCsrfClient — transport failures + retries', () => {
  // A fetch that hangs until its AbortSignal fires, then rejects — models
  // a dropped/aborted connection (the mobile-Safari "Load failed" case).
  function hangUntilAbort(): FetchMock {
    return vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) return reject(new Error('aborted'))
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ) as FetchMock
  }

  it('wraps a transport rejection as ApiError(network_error, status 0) for an enhanced call', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Load failed'))
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const err = await client
      .request('GET', '/api/v1/ui/x', undefined, { timeoutMs: 1000 })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('network_error')
    expect((err as ApiError).status).toBe(0)
    // No retry unless opted in.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('propagates the raw transport rejection unchanged for a plain call (no options)', async () => {
    // The default contract every existing consumer relies on: a rejected
    // fetch surfaces as-is (no ApiError, no numeric status) so classifiers
    // that key on the ABSENCE of a numeric `.status` (session
    // revalidation) still treat it as a transport failure and keep the
    // cached session instead of bouncing.
    const boom = new TypeError('Load failed')
    const fetchMock = vi.fn().mockRejectedValue(boom)
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const err = await client.request('GET', '/api/v1/ui/x').catch((e: unknown) => e)

    expect(err).toBe(boom)
    expect(err).not.toBeInstanceOf(ApiError)
  })

  it('does NOT pass a signal when no timeout/signal is requested', async () => {
    const fetchMock = makeFetch([jsonResp({ ok: true })])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.request('GET', '/api/v1/ui/x')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBeUndefined()
  })

  it('times out an unresponsive fetch as ApiError(timeout)', async () => {
    const fetchMock = hangUntilAbort()
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const err = await client
      .request('GET', '/api/v1/ui/x', undefined, { timeoutMs: 5 })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('timeout')
    expect((err as ApiError).status).toBe(0)
  })

  it('reports a caller-aborted request as ApiError(request_aborted)', async () => {
    const fetchMock = hangUntilAbort()
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })
    const controller = new AbortController()
    controller.abort()

    const err = await client
      .request('GET', '/api/v1/ui/x', undefined, { signal: controller.signal })
      .catch((e: unknown) => e)

    expect((err as ApiError).code).toBe('request_aborted')
  })

  it('auto-retries a transient transport drop when retries are opted in', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(jsonResp({ ok: true }) as Response)
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const out = await client.request('GET', '/api/v1/ui/x', undefined, { retries: 1 })

    expect(out).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a server 5xx even when retries are opted in', async () => {
    const fetchMock = makeFetch([
      {
        ok: false,
        status: 503,
        json: async () => ({ error: { code: 'ai_capacity', message: 'at capacity' } }),
        clone() {
          return this as unknown as Response
        },
      } as Partial<Response>,
    ])
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const err = await client
      .request('GET', '/api/v1/ui/x', undefined, { retries: 2 })
      .catch((e: unknown) => e)

    // Default retryOn is transport-only — a rejecting server is surfaced,
    // not hammered.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((err as ApiError).code).toBe('ai_capacity')
    expect((err as ApiError).status).toBe(503)
  })

  it('bounds the CSRF bootstrap leg by the caller timeout', async () => {
    // The /csrf GET hangs; with a timeout set, the bootstrap itself must
    // abort (it used to be unbounded even when the caller passed a
    // timeout for the mutation).
    const fetchMock = hangUntilAbort()
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const err = await client
      .request('POST', '/api/v1/ui/thing', { x: 1 }, { timeoutMs: 5 })
      .catch((e: unknown) => e)

    expect((err as ApiError).code).toBe('timeout')
    // Only the bootstrap fired; the mutation never got a token to send.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [csrfUrl] = fetchMock.mock.calls[0] as [string]
    expect(csrfUrl).toBe('/api/v1/ui/csrf')
  })

  it('honours a custom retryOn to retry a chosen server code', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: { code: 'ai_capacity' } }),
        clone() {
          return this as unknown as Response
        },
      } as Partial<Response>)
      .mockResolvedValueOnce(jsonResp({ ok: true }) as Response)
    const client = createCsrfClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const out = await client.request('GET', '/api/v1/ui/x', undefined, {
      retries: 1,
      retryOn: (e) => e.code === 'ai_capacity',
    })

    expect(out).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
