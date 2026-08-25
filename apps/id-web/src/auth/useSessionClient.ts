import { useEffect, useState, useCallback, useRef } from 'react'
import type { UserInfo } from '@rallypoint/shared'
import { sanitizeColor, sanitizeTheme, useThemeStore } from '@rallypoint/ui'
import { identify, analyticsPersonProps } from '@rallypoint/web-kit'
import { api } from '../api/client.js'

// The session probe folds the shared settings doc in alongside the
// userinfo (id-api GET /ui/session). Theme keys, when present, hydrate
// the store so the preference follows the user across devices.
type SessionPayload = UserInfo & { settings?: Record<string, unknown> }

// Write-through is gated on an authenticated session: the PATCH route is
// cookie-only, so firing it before sign-in just 401s. We register the
// store subscription once (module-level), enable it after the first
// authenticated probe, and suppress it while hydrating so the freshly
// applied server value isn't echoed straight back as a write.
let writeThroughEnabled = false
let suppressWriteThrough = false
let subscribed = false

function ensureWriteThroughSubscription(): void {
  if (subscribed) return
  subscribed = true
  useThemeStore.subscribe((s, prev) => {
    if (!writeThroughEnabled || suppressWriteThrough) return
    if (s.mode === prev.mode && s.color === prev.color) return
    void api.patch('/api/v1/ui/settings/shared', {
      themeMode: s.mode,
      themeColor: s.color,
    })
  })
}

function hydrateTheme(settings: Record<string, unknown> | undefined): void {
  if (!settings) return
  suppressWriteThrough = true
  try {
    const { setMode, setColor } = useThemeStore.getState()
    if (typeof settings.themeMode === 'string') setMode(sanitizeTheme(settings.themeMode))
    if (typeof settings.themeColor === 'string') setColor(sanitizeColor(settings.themeColor))
  } finally {
    suppressWriteThrough = false
  }
}

// Client-side session hook for the hosted UI. The hosted UI lives
// on the same origin as the API, so we read /api/v1/ui/session
// (cookie-authenticated) rather than the SDK's
// /api/v1/sdk/session/verify (which needs a bearer).
//
// Returns loading / authenticated / unauthenticated / error
// states. The settings/delete pages use this to gate access:
// redirect to /signin if unauthenticated.
//
// Frozen-PWA hardening (mirrors @rallypoint/web-kit's session probe):
// when an installed PWA is suspended mid-probe, the in-flight fetch is
// left dangling on resume — `api.get` never settles (no resolve, no
// reject), so the gate would sit on 'loading' until force-quit. Two
// guards prevent that: a per-probe watchdog flips a never-settling probe
// to 'error', and we re-probe on tab refocus / regained connectivity
// while the last probe is still 'loading' or 'error'. A per-probe
// sequence token lets a fresh probe supersede the dangling one without
// the stale result clobbering the recovered session.

// Backstop timeout for a single session probe (see above).
const PROBE_TIMEOUT_MS = 10_000

export interface SessionState {
  status: 'loading' | 'authenticated' | 'unauthenticated' | 'error'
  user: UserInfo | null
  error: string | null
  refetch: () => void
}

export function useSessionClient(): SessionState {
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{
    status: SessionState['status']
    user: UserInfo | null
    error: string | null
  }>({ status: 'loading', user: null, error: null })

  // Mirror the committed status so the event handlers can gate on it
  // without re-binding every render (the effect runs once per `tick`).
  const statusRef = useRef(state.status)
  statusRef.current = state.status

  useEffect(() => {
    let cancelled = false
    let probeSeq = 0
    let activeWatchdog: ReturnType<typeof setTimeout> | undefined

    const probe = (): void => {
      const seq = ++probeSeq
      let settled = false
      const commit = (run: () => void): void => {
        // Drop the result of a superseded/stale probe (e.g. a dangling
        // fetch that resurrects after resume) and of any post-unmount settle.
        if (cancelled || seq !== probeSeq || settled) return
        settled = true
        if (activeWatchdog) clearTimeout(activeWatchdog)
        run()
      }

      // Watchdog: a probe that never settles is committed as an error so
      // the gate self-heals (the user gets the retry card) instead of
      // wedging on 'loading'. A new probe supersedes the previous watchdog.
      if (activeWatchdog) clearTimeout(activeWatchdog)
      activeWatchdog = setTimeout(() => {
        commit(() =>
          setState({ status: 'error', user: null, error: 'Session check timed out.' }),
        )
      }, PROBE_TIMEOUT_MS)

      api
        .get<SessionPayload>('/api/v1/ui/session')
        .then((res) => {
          commit(() => {
            if (res.ok) {
              ensureWriteThroughSubscription()
              hydrateTheme(res.data.settings)
              writeThroughEnabled = true
              // distinct_id is the stable RPID user id (`sub`). UserInfo.name is
              // the display username column (=== preferred_username, see #295),
              // so it maps to `username` — analyticsPersonProps prefers
              // first+last for the person `name` and only falls back to it.
              identify(
                res.data.sub,
                analyticsPersonProps({
                  email: res.data.email,
                  username: res.data.name,
                  first_name: res.data.first_name,
                  last_name: res.data.last_name,
                }),
              )
              setState({ status: 'authenticated', user: res.data, error: null })
            } else if (res.status === 401) {
              writeThroughEnabled = false
              setState({ status: 'unauthenticated', user: null, error: null })
            } else {
              setState({ status: 'error', user: null, error: res.error.message })
            }
          })
        })
        // api.get resolves an envelope rather than throwing, but guard a
        // synchronous/unexpected rejection so a probe can't hang silently.
        .catch(() => {
          commit(() =>
            setState({ status: 'error', user: null, error: 'Network error' }),
          )
        })
    }

    probe()

    // Re-probe on tab refocus / regained connectivity while the last probe
    // hasn't settled into a good state. 'loading' is included (not just
    // 'error') so a PWA resumed mid-probe fires a fresh, superseding probe
    // immediately. 'authenticated'/'unauthenticated' are settled and never
    // re-probed — a healthy tab won't re-hit the session endpoint on focus.
    const reprobeIfStuck = (): void => {
      if (cancelled) return
      if (statusRef.current === 'error' || statusRef.current === 'loading') probe()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') reprobeIfStuck()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', reprobeIfStuck)

    return () => {
      cancelled = true
      if (activeWatchdog) clearTimeout(activeWatchdog)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', reprobeIfStuck)
    }
  }, [tick])

  const refetch = useCallback(() => setTick((n) => n + 1), [])
  return { ...state, refetch }
}
