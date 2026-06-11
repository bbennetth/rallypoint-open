import { useEffect, useRef, useState } from 'react'
import type { UserInfo } from '../types.js'

// useSession — React hook for the BROWSER side. Fetches the
// cookie-authenticated /api/v1/ui/session endpoint on mount.
//
// Important: this works ONLY when the browser is on the same
// origin as the API (the hosted Rallypoint ID UI itself, or any
// app served from the same origin via reverse proxy). For SDK
// consumers on a different origin, redirect the user to the
// hosted UI (signinUrl) and have your server call
// SessionVerifier.verifySession() on the resulting session-bearer
// you exchange — the cookie is host-isolated by `__Host-` prefix.
//
// Performance notes (#40):
//   - The hook fires a fetch on every mount, including for users
//     who have never signed in. The session cookie is HttpOnly,
//     so there's no client-side way to short-circuit. Each
//     unauthenticated visit costs one /api/v1/ui/session round
//     trip (which returns 401 fast). Consumers expecting many
//     anonymous visits can pass `initialState: 'unauthenticated'`
//     to skip the first call.
//
// Identity stability (#38):
//   - `apiBase` and `fetchImpl` are captured in refs on first
//     render; subsequent changes to either are NOT honored. If
//     you need to switch backends mid-app, mount a new component
//     instance (key change) instead of toggling the prop.

export interface UseSessionOptions {
  /** Defaults to '' (same origin). Useful for tests or reverse-proxy setups. */
  apiBase?: string
  /** Override fetch impl for tests. */
  fetchImpl?: typeof fetch
  /**
   * Skip the initial /session fetch and start in this state.
   * Use `'unauthenticated'` on pages that know the visitor isn't
   * signed in to avoid the wasted RTT (#40). `refetch()` still
   * works normally.
   */
  initialState?: 'loading' | 'unauthenticated'
}

export interface UseSessionResult {
  status: 'loading' | 'authenticated' | 'unauthenticated' | 'error'
  user: UserInfo | null
  error: Error | null
  refetch: () => void
}

export function useSession(opts: UseSessionOptions = {}): UseSessionResult {
  // Capture identity-sensitive opts on first render (#38). Effect
  // deps stay stable so inline-literal apiBase / arrow-function
  // fetchImpl don't trigger a re-fetch every render.
  const apiBaseRef = useRef(opts.apiBase ?? '')
  const fetchRef = useRef(opts.fetchImpl ?? fetch)

  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{
    status: UseSessionResult['status']
    user: UserInfo | null
    error: Error | null
  }>(() => ({
    status: opts.initialState ?? 'loading',
    user: null,
    error: null,
  }))

  useEffect(() => {
    // Honor initialState on first mount (#40) — skip the fetch.
    if (tick === 0 && opts.initialState === 'unauthenticated') return undefined
    let cancelled = false
    const fetchImpl = fetchRef.current
    const apiBase = apiBaseRef.current
    fetchImpl(`${apiBase}/api/v1/ui/session`, {
      credentials: 'include',
      method: 'GET',
    })
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 200) {
          const user = (await res.json()) as UserInfo
          setState({ status: 'authenticated', user, error: null })
        } else if (res.status === 401) {
          setState({ status: 'unauthenticated', user: null, error: null })
        } else {
          setState({
            status: 'error',
            user: null,
            error: new Error(`unexpected status ${res.status}`),
          })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          user: null,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })
    return () => {
      cancelled = true
    }
    // tick alone — refs are intentionally not in deps (#38).
    // apiBaseRef.current / fetchRef.current are captured on first
    // render and don't change.
  }, [tick, opts.initialState])

  return {
    ...state,
    refetch: () => setTick((n) => n + 1),
  }
}

// Convenience for consumers that just want the user, not the
// loading state.
export function useUser(opts: UseSessionOptions = {}): UserInfo | null {
  return useSession(opts).user
}
