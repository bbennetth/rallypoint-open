import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock @rallypoint/ui at module scope (vi.mock is only hoisted from the top
// level, not from inside an `it`). The hoisted spy lets the hydration tests
// assert how getSession folds the shared settings doc into the theme store.
const { hydrateThemeSpy } = vi.hoisted(() => ({ hydrateThemeSpy: vi.fn() }))
vi.mock('@rallypoint/ui', () => ({ hydrateThemeFromServer: hydrateThemeSpy }))

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
        settings: { themeMode: 'light', themeColor: 'green' },
      }),
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { getSession } = await import('./api.js')
    const session = await getSession()

    expect(session.user_id).toBe('user_abc')
    expect(hydrateThemeSpy).toHaveBeenCalledWith({
      mode: 'light',
      color: 'green',
    })
  })

  it('does not call hydrateThemeFromServer when the session has no settings', async () => {
    const fetchMock = makeFetch([jsonResp({ user_id: 'user_xyz' })])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { getSession } = await import('./api.js')
    await getSession()

    expect(hydrateThemeSpy).not.toHaveBeenCalled()
  })
})
