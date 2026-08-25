// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createSession, type SessionConfig } from './session.js'
import { createRequireSession } from './RequireSession.js'
import { ApiError } from './csrf.js'
import { identify } from './analytics.js'

// Spy on the analytics seam so the identify-on-authenticated-probe wiring
// is assertable without a real PostHog client (virtual:analytics resolves
// to the no-op stub in tests via the root vitest config alias).
vi.mock('./analytics.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./analytics.js')>()
  return { ...mod, identify: vi.fn() }
})

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

  it('shows the error state (no bounce) after a persistent non-401 failure', async () => {
    // Mount defers the first failure (stays on the spinner) and the panel
    // only surfaces once the ~1.5s backoff re-probe ALSO fails — hence the
    // widened findByText timeout.
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

    await screen.findByText(/Couldn't reach the server/i, undefined, { timeout: 3000 })
    // The server-supplied message ('RPID down') must NOT be rendered —
    // error copy is mapped to a fixed local string keyed by HTTP status.
    expect(screen.queryByText('RPID down')).toBeNull()
    expect(screen.getByText(/HTTP 503/)).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('maps a non-HTTP failure to the generic unreachable message', async () => {
    const session = createSession(
      baseConfig({
        getSession: async () => {
          throw new TypeError('fetch failed: attacker controlled text')
        },
        navigate: vi.fn(),
      }),
    )
    const RequireSession = createRequireSession(session)
    render(<RequireSession>{() => <div>secret</div>}</RequireSession>)
    // globals:false → no auto-cleanup in this describe; assert on this
    // test's unique copy rather than the shared error heading.
    await screen.findByText(/Could not reach the sign-in service/, undefined, { timeout: 3000 })
    expect(screen.queryByText(/attacker controlled/)).toBeNull()
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
    // Two rejections (mount + deferred backoff re-probe) are needed to reach
    // the committed error state now that the first failure is suppressed.
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValueOnce(new ApiError('upstream_unavailable', 'RPID down', 503))
      .mockRejectedValueOnce(new ApiError('upstream_unavailable', 'RPID down', 503))
      .mockResolvedValue({ user_id: 'user_7' })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    await waitFor(() => expect(stateText()).toBe('error:'), { timeout: 3000 })
    expect(getSession).toHaveBeenCalledTimes(2)

    setVisibility('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    // Hidden → visible is the trigger; a hidden event must not re-probe.
    expect(getSession).toHaveBeenCalledTimes(2)

    setVisibility('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(stateText()).toBe('authenticated:user_7'))
    expect(getSession).toHaveBeenCalledTimes(3)
  })

  it('re-probes on `online` while in the error state and recovers', async () => {
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValueOnce(new ApiError('upstream_unavailable', 'RPID down', 503))
      .mockRejectedValueOnce(new ApiError('upstream_unavailable', 'RPID down', 503))
      .mockResolvedValue({ user_id: 'user_8' })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    await waitFor(() => expect(stateText()).toBe('error:'), { timeout: 3000 })
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

    // The mount failure is deferred: the gate stays on the neutral spinner
    // (no error flash) while the backoff re-probe is pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stateText()).toBe('loading:')

    // The single backoff retry fires and recovers without any user action.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(stateText()).toBe('authenticated:user_9')
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  it('re-probes on visibilitychange→visible while stuck loading (frozen-PWA resume) and recovers', async () => {
    // The first probe never settles — the frozen-PWA case where iOS
    // suspends the app mid-request and the promise is left dangling on
    // resume. The gate would otherwise sit on 'loading' until force-quit.
    let resolveFirst: ((v: { user_id: string }) => void) | undefined
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockImplementationOnce(
        () =>
          new Promise<{ user_id: string }>((res) => {
            resolveFirst = res
          }),
      )
      .mockResolvedValue({ user_id: 'user_pwa' })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    // Wedged on loading: the first probe is in flight and never settles.
    expect(stateText()).toBe('loading:')
    expect(getSession).toHaveBeenCalledTimes(1)

    // Returning to the foreground fires a fresh probe that supersedes the
    // dangling one — the recovery the old error-only gate never reached.
    setVisibility('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(stateText()).toBe('authenticated:user_pwa'))
    expect(getSession).toHaveBeenCalledTimes(2)

    // If the original frozen probe later resurrects, its stale sequence
    // token means it must not clobber the recovered session.
    resolveFirst?.({ user_id: 'STALE' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(stateText()).toBe('authenticated:user_pwa')
  })

  it('watchdog converts a never-settling probe into recovery (no permanent loading)', async () => {
    vi.useFakeTimers()
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      // Never settles: no resolve, no reject — the dangling-fetch case.
      .mockImplementationOnce(() => new Promise<{ user_id: string }>(() => {}))
      .mockResolvedValue({ user_id: 'user_wd' })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    expect(stateText()).toBe('loading:')

    // No focus event arrives, but the watchdog backstops the hang: it fires
    // after the timeout and treats the never-settling probe as a transient
    // failure. On the deferred mount probe that keeps the spinner (no flash)
    // and still kicks the backoff re-probe.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(stateText()).toBe('loading:')

    // …which feeds the existing backoff re-probe, recovering hands-free.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(stateText()).toBe('authenticated:user_wd')
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  it('initial transient failure stays on loading (no error flash) until the backoff re-probe also fails', async () => {
    vi.useFakeTimers()
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValueOnce(new ApiError('upstream_unavailable', 'RPID down', 503))
      .mockRejectedValueOnce(new ApiError('upstream_unavailable', 'RPID down', 503))
      .mockResolvedValue({ user_id: 'user_defer' })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    // Mount probe rejects, but the gate holds on the spinner — no flash.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stateText()).toBe('loading:')
    expect(getSession).toHaveBeenCalledTimes(1)

    // The backoff re-probe (second strike) fails → the panel finally commits.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(stateText()).toBe('error:')
    expect(getSession).toHaveBeenCalledTimes(2)

    // A regained-connectivity re-probe then recovers hands-free.
    act(() => window.dispatchEvent(new Event('online')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stateText()).toBe('authenticated:user_defer')
    expect(getSession).toHaveBeenCalledTimes(3)
  })

  it('a recovery during the deferred window cancels the pending backoff re-probe', async () => {
    vi.useFakeTimers()
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValueOnce(new ApiError('upstream_unavailable', 'RPID down', 503))
      .mockResolvedValue({ user_id: 'user_cancel' })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    // Mount fails → deferred loading, backoff scheduled for +1500ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stateText()).toBe('loading:')
    expect(getSession).toHaveBeenCalledTimes(1)

    // Regain connectivity BEFORE the backoff fires → recovers immediately.
    act(() => window.dispatchEvent(new Event('online')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stateText()).toBe('authenticated:user_cancel')
    expect(getSession).toHaveBeenCalledTimes(2)

    // The now-superfluous backoff must have been cancelled — no 3rd probe.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  it('focus/online re-probe failure commits error immediately without its own backoff', async () => {
    vi.useFakeTimers()
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValue(new ApiError('upstream_unavailable', 'RPID down', 503))
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    // Reach the committed error state: mount (deferred → loading) then the
    // backoff re-probe fails.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stateText()).toBe('loading:')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(stateText()).toBe('error:')
    expect(getSession).toHaveBeenCalledTimes(2)

    // An `online` re-probe that fails commits 'error' with no deferral, and
    // — unlike the mount probe — schedules no fresh backoff of its own.
    act(() => window.dispatchEvent(new Event('online')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stateText()).toBe('error:')
    expect(getSession).toHaveBeenCalledTimes(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(getSession).toHaveBeenCalledTimes(3)
  })

  it('401 on the initial probe bounces immediately (deferral is transient-only)', async () => {
    vi.useFakeTimers()
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValue(new ApiError('unauthorized', 'nope', 401))
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    // A 401 is a settled result: committed immediately, never held on the
    // spinner and never retried.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stateText()).toBe('unauthenticated:')
    expect(getSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(getSession).toHaveBeenCalledTimes(1)
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

  it('identifies the user with person props on a successful probe', async () => {
    vi.mocked(identify).mockClear()
    const getSession = vi.fn<SessionConfig['getSession']>().mockResolvedValue({
      user_id: 'user_9',
      profile: {
        username: 'byron',
        first_name: 'Byron',
        last_name: 'Howell',
        picture_url: null,
        email: 'b@example.com',
      },
    })
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    await waitFor(() => expect(stateText()).toBe('authenticated:user_9'))
    expect(identify).toHaveBeenCalledWith('user_9', {
      email: 'b@example.com',
      name: 'Byron Howell',
    })
  })

  it('does NOT identify on an unauthenticated (401) probe', async () => {
    vi.mocked(identify).mockClear()
    const getSession = vi
      .fn<SessionConfig['getSession']>()
      .mockRejectedValue(new ApiError('unauthorized', 'nope', 401))
    const session = createSession(baseConfig({ getSession, navigate: vi.fn() }))
    render(<Harness session={session} />)

    await waitFor(() => expect(stateText()).toBe('unauthenticated:'))
    expect(identify).not.toHaveBeenCalled()
  })
})
