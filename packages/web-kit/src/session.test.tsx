// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createSession, type SessionConfig } from './session.js'
import { createRequireSession } from './RequireSession.js'
import { ApiError } from './csrf.js'

function baseConfig(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    clientName: 'events',
    stateCookieName: 'rpe_sso_state',
    rpidUiUrl: 'http://localhost:5173',
    secureCookie: false,
    getSession: async () => ({ user_id: 'user_1' }),
    ...over,
  }
}

describe('createSession — state cookie helpers', () => {
  beforeEach(() => {
    // Wipe any cookie left by a prior test.
    for (const part of document.cookie.split(';')) {
      const name = part.split('=')[0]?.trim()
      if (name) document.cookie = `${name}=; Path=/; Max-Age=0`
    }
  })

  it('beginSso writes the state cookie and navigates to RPID authorize', () => {
    const assign = vi.fn()
    const session = createSession(baseConfig({ navigate: assign }))
    session.beginSso('https://events.rallypt.app/me/events')

    const nonce = session.readStateCookie()
    expect(nonce).toBeTruthy()
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)

    expect(assign).toHaveBeenCalledTimes(1)
    const url = new URL((assign.mock.calls[0] as [string])[0])
    expect(url.origin).toBe('http://localhost:5173')
    expect(url.pathname).toBe('/sso/authorize')
    expect(url.searchParams.get('client')).toBe('events')
    expect(url.searchParams.get('state')).toBe(nonce)
    const returnTo = new URL(url.searchParams.get('return_to')!)
    expect(returnTo.pathname).toBe('/sso/callback')
    expect(returnTo.searchParams.get('dest')).toBe('https://events.rallypt.app/me/events')
  })

  it('beginSso with prompt:none adds prompt=none to the authorize URL', () => {
    const assign = vi.fn()
    const session = createSession(baseConfig({ navigate: assign }))
    session.beginSso('/me/events', { prompt: 'none' })

    const url = new URL((assign.mock.calls[0] as [string])[0])
    expect(url.searchParams.get('prompt')).toBe('none')
  })

  it('beginSso without opts does NOT include prompt param', () => {
    const assign = vi.fn()
    const session = createSession(baseConfig({ navigate: assign }))
    session.beginSso('/me/events')

    const url = new URL((assign.mock.calls[0] as [string])[0])
    expect(url.searchParams.has('prompt')).toBe(false)
  })

  it('uses the configured client name + cookie name (lists)', () => {
    const session = createSession(
      baseConfig({ clientName: 'lists', stateCookieName: 'rpl_sso_state', navigate: vi.fn() }),
    )
    session.beginSso()
    expect(document.cookie).toContain('rpl_sso_state=')
  })

  it('clearStateCookie removes the cookie', () => {
    const session = createSession(baseConfig({ navigate: vi.fn() }))
    session.beginSso()
    expect(session.readStateCookie()).toBeTruthy()
    session.clearStateCookie()
    expect(session.readStateCookie()).toBeNull()
  })
})

describe('createRequireSession gate', () => {
  it('renders children with the user id when authenticated', async () => {
    const session = createSession(
      baseConfig({ getSession: async () => ({ user_id: 'user_42' }), navigate: vi.fn() }),
    )
    const RequireSession = createRequireSession(session)
    render(<RequireSession>{(userId) => <div>hello {userId}</div>}</RequireSession>)
    await screen.findByText('hello user_42')
  })

  it('bounces to SSO on a 401 (unauthenticated)', async () => {
    const navigate = vi.fn()
    const session = createSession(
      baseConfig({
        getSession: async () => {
          throw new ApiError('unauthorized', 'nope', 401)
        },
        navigate,
      }),
    )
    const RequireSession = createRequireSession(session)
    render(<RequireSession>{() => <div>secret</div>}</RequireSession>)

    await screen.findByText(/Redirecting to sign in/i)
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('secret')).toBeNull()
  })

  it('bounces on a 401-shaped error that is not an ApiError instance', async () => {
    const navigate = vi.fn()
    const session = createSession(
      baseConfig({
        getSession: async () => {
          throw { name: 'OtherError', status: 401, message: 'nope' }
        },
        navigate,
      }),
    )
    const RequireSession = createRequireSession(session)
    render(<RequireSession>{() => <div>secret</div>}</RequireSession>)

    await screen.findByText(/Redirecting to sign in/i)
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('secret')).toBeNull()
  })

  it('shows the error state (no bounce) on a non-401 failure', async () => {
    const navigate = vi.fn()
    const session = createSession(
      baseConfig({
        getSession: async () => {
          throw new ApiError('upstream_unavailable', 'RPID down', 503)
        },
        navigate,
      }),
    )
    const RequireSession = createRequireSession(session)
    render(<RequireSession>{() => <div>secret</div>}</RequireSession>)

    await screen.findByText(/Couldn't reach the server/i)
    expect(screen.getByText('RPID down')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('useSession — re-probe after a transient failure', () => {
  // A minimal harness that surfaces the raw hook state so we can assert
  // status transitions and drive visibilitychange/online events directly.
  function Harness({ session }: { session: ReturnType<typeof createSession> }) {
    const s = session.useSession()
    return <div data-testid="state">{`${s.status}:${s.userId ?? ''}`}</div>
  }
  const stateText = () => screen.getByTestId('state').textContent

  function setVisibility(value: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => value,
    })
  }

  beforeEach(() => setVisibility('visible'))
  afterEach(() => {
    // globals:false disables Testing Library's auto-cleanup, so unmount the
    // harness between tests — these all share the `state` testid.
    cleanup()
    vi.useRealTimers()
    setVisibility('visible')
  })

  it('re-probes on visibilitychange→visible while in the error state and recovers', async () => {
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValueOnce(new ApiError('upstream_unavailable', 'RPID down', 503))
      .mockResolvedValue({ user_id: 'user_7' })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    await waitFor(() => expect(stateText()).toBe('error:'))

    setVisibility('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    // Hidden → visible is the trigger; a hidden event must not re-probe.
    expect(getSession).toHaveBeenCalledTimes(1)

    setVisibility('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(stateText()).toBe('authenticated:user_7'))
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  it('re-probes on `online` while in the error state and recovers', async () => {
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValueOnce(new ApiError('upstream_unavailable', 'RPID down', 503))
      .mockResolvedValue({ user_id: 'user_8' })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    await waitFor(() => expect(stateText()).toBe('error:'))
    act(() => window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(stateText()).toBe('authenticated:user_8'))
  })

  it('auto re-probes once after a short backoff on a transient mount failure', async () => {
    vi.useFakeTimers()
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValueOnce(new ApiError('upstream_unavailable', 'RPID down', 503))
      .mockResolvedValue({ user_id: 'user_9' })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    // Let the rejected mount probe settle into the error state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stateText()).toBe('error:')

    // The single backoff retry fires and recovers without any user action.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(stateText()).toBe('authenticated:user_9')
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  it('does NOT re-probe on focus when already authenticated', async () => {
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockResolvedValue({ user_id: 'user_10' })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    await waitFor(() => expect(stateText()).toBe('authenticated:user_10'))
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => window.dispatchEvent(new Event('online')))
    // Gated on status==='error', so a healthy session never re-hits RPID.
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-probe on focus/online when unauthenticated (settled 401)', async () => {
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValue(new ApiError('unauthorized', 'nope', 401))
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    await waitFor(() => expect(stateText()).toBe('unauthenticated:'))
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => window.dispatchEvent(new Event('online')))
    // 401 is a settled state (not 'error'), so the app drives the SSO
    // bounce — web-kit must not keep re-hitting RPID on every focus.
    expect(getSession).toHaveBeenCalledTimes(1)
  })
})
