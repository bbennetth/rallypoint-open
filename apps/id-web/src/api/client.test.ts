import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApiClient, checkAvatarFile, type ApiFailure } from './client.js'

// Minimal Response-like stub covering the fields the client reads
// (ok, status, json, text).
function res(opts: { ok: boolean; status: number; body?: unknown }) {
  const text = opts.body === undefined ? '' : JSON.stringify(opts.body)
  return {
    ok: opts.ok,
    status: opts.status,
    json: async () => opts.body ?? null,
    text: async () => text,
  } as unknown as Response
}

function isCsrf(url: unknown): boolean {
  return String(url).includes('/api/v1/ui/csrf')
}

describe('createApiClient — CSRF bootstrap (#45)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries bootstrap once and sends X-RP-CSRF when the retry succeeds', async () => {
    let csrfCalls = 0
    fetchMock.mockImplementation(async (url: unknown) => {
      if (isCsrf(url)) {
        csrfCalls += 1
        if (csrfCalls === 1) return res({ ok: false, status: 503 })
        return res({ ok: true, status: 200, body: { ok: true, csrfToken: 'tok-123' } })
      }
      return res({ ok: true, status: 200, body: { ok: true } })
    })

    const client = createApiClient()
    const result = await client.post('/api/v1/ui/thing', { a: 1 })

    expect(result.ok).toBe(true)
    expect(csrfCalls).toBe(2)
    const postCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/thing'))
    expect(postCall).toBeDefined()
    const headers = (postCall![1] as RequestInit).headers as Record<string, string>
    expect(headers['X-RP-CSRF']).toBe('tok-123')
  })

  it('returns csrf_bootstrap_failed (and fires no request) when both attempts fail', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (isCsrf(url)) return res({ ok: false, status: 503 })
      return res({ ok: true, status: 200, body: { ok: true } })
    })

    const client = createApiClient()
    const result = await client.post('/api/v1/ui/thing', { a: 1 })

    expect(result.ok).toBe(false)
    expect((result as ApiFailure).error.code).toBe('csrf_bootstrap_failed')
    const postCalled = fetchMock.mock.calls.some((c) => String(c[0]).includes('/thing'))
    expect(postCalled).toBe(false)
  })

  it('does not bootstrap CSRF for GET requests', async () => {
    fetchMock.mockImplementation(async () => res({ ok: true, status: 200, body: { ok: true } }))

    const client = createApiClient()
    await client.get('/api/v1/ui/session')

    expect(fetchMock.mock.calls.some((c) => isCsrf(c[0]))).toBe(false)
  })
})

const TWO_MB = 2 * 1024 * 1024
const TWENTY_FIVE_MB = 25 * 1024 * 1024

// checkAvatarFile is the pre-resize INPUT guard: it accepts the generous
// source limits (up to 25 MB, PNG/JPEG/WebP). Large photos that pass here are
// downscaled+re-encoded in the browser before the strict 2 MB OUTPUT gate.
describe('checkAvatarFile', () => {
  it('accepts a multi-MB source image within the input limit', () => {
    expect(checkAvatarFile({ type: 'image/png', size: 1024 })).toBeNull()
    expect(checkAvatarFile({ type: 'image/jpeg', size: TWO_MB })).toBeNull()
    // 8 MB phone photo: rejected before (2 MB source gate), accepted now.
    expect(checkAvatarFile({ type: 'image/jpeg', size: 8 * 1024 * 1024 })).toBeNull()
    expect(checkAvatarFile({ type: 'image/webp', size: 1 })).toBeNull()
  })

  it('rejects an unsupported type', () => {
    const r = checkAvatarFile({ type: 'image/gif', size: 1024 })
    expect(r?.ok).toBe(false)
    expect(r?.error.code).toBe('unsupported_input_type')
  })

  it('rejects a source file above the input limit', () => {
    const r = checkAvatarFile({ type: 'image/png', size: TWENTY_FIVE_MB + 1 })
    expect(r?.ok).toBe(false)
    expect(r?.error.code).toBe('input_too_large')
  })

  it('rejects an empty file', () => {
    const r = checkAvatarFile({ type: 'image/png', size: 0 })
    expect(r?.ok).toBe(false)
    expect(r?.error.code).toBe('input_too_large')
  })
})
