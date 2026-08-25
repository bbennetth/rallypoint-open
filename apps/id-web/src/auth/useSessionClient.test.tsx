// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useSessionClient } from './useSessionClient.js'

// Frozen-PWA hardening for the hosted-UI session probe (mirrors the
// @rallypoint/web-kit RequireSession fix). The hook reads GET
// /api/v1/ui/session via the shared api client, which calls global
// `fetch` — so we drive it by stubbing `fetch`. The danger case is a
// fetch that never settles (iOS suspends the PWA mid-request): the gate
// must not sit on 'loading' forever.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const SESSION = '/api/v1/ui/session'

// Render the raw hook state so we can assert status transitions and
// drive visibilitychange / online events directly.
function Harness() {
  const s = useSessionClient()
  return <div data-testid="state">{`${s.status}:${s.user?.sub ?? ''}`}</div>
}
const stateText = () => screen.getByTestId('state').textContent

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  })
}

// Only the session probe goes through `fetch` in these tests; route by URL
// so an unexpected call is obvious rather than silently 200-ing.
function stubFetch(handler: (url: string) => Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes(SESSION)) return handler(url)
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  })
}

describe('useSessionClient — frozen-PWA hardening', () => {
  beforeEach(() => setVisibility('visible'))
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    setVisibility('visible')
  })

  it('re-probes on visibilitychange→visible while stuck loading and recovers', async () => {
    // First probe never settles — the dangling-fetch case on PWA resume.
    let calls = 0
    stubFetch(() => {
      calls += 1
      if (calls === 1) return new Promise<Response>(() => {}) // never settles
      return Promise.resolve(jsonResponse({ sub: 'user_pwa', name: 'pwa' }))
    })

    render(<Harness />)
    expect(stateText()).toBe('loading:')

    setVisibility('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(stateText()).toBe('authenticated:user_pwa'))
    expect(calls).toBe(2)
  })

  it('watchdog flips a never-settling probe to error (no permanent loading)', async () => {
    vi.useFakeTimers()
    stubFetch(() => new Promise<Response>(() => {})) // never settles
    render(<Harness />)

    expect(stateText()).toBe('loading:')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(stateText()).toBe('error:')
  })

  it('re-probes on `online` while in the error state and recovers', async () => {
    let calls = 0
    stubFetch(() => {
      calls += 1
      if (calls === 1) return Promise.resolve(jsonResponse({ error: { code: 'x', message: 'down' } }, 503))
      return Promise.resolve(jsonResponse({ sub: 'user_on', name: 'on' }))
    })

    render(<Harness />)
    await waitFor(() => expect(stateText()).toBe('error:'))

    act(() => window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(stateText()).toBe('authenticated:user_on'))
    expect(calls).toBe(2)
  })

  it('does NOT re-probe on focus/online once authenticated (settled)', async () => {
    let calls = 0
    stubFetch(() => {
      calls += 1
      return Promise.resolve(jsonResponse({ sub: 'user_ok', name: 'ok' }))
    })

    render(<Harness />)
    await waitFor(() => expect(stateText()).toBe('authenticated:user_ok'))
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => window.dispatchEvent(new Event('online')))
    expect(calls).toBe(1)
  })

  it('does NOT re-probe on focus/online when unauthenticated (settled 401)', async () => {
    let calls = 0
    stubFetch(() => {
      calls += 1
      return Promise.resolve(jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401))
    })

    render(<Harness />)
    await waitFor(() => expect(stateText()).toBe('unauthenticated:'))
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => window.dispatchEvent(new Event('online')))
    expect(calls).toBe(1)
  })
})
