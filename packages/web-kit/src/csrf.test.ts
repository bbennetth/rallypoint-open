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
