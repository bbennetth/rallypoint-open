import { useEffect, useRef, useState } from 'react'
import { ApiError } from './csrf.js'

// Shared cross-subdomain SSO bootstrap + session probe for the
// Rallypoint web apps (design §3.13). Neither events-api nor lists-api
// has a password UI of its own; an unauthenticated user is bounced to
// RPID's hosted /sso/authorize, which mints a single-use code and
// redirects back to the app's /sso/callback. The callback exchanges
// that code for an app session cookie.
//
// The `state` nonce is the anti-CSRF token for the SSO leg: minted
// here, stashed in a short-lived cookie, handed to RPID, and the
// callback's exchange call requires the cookie and the round-tripped
// value to match (the API checks it with a constant-time compare).
//
// Collapses the 95%-identical per-app `lib/session.ts` modules — the
// only diffs were `client` (events|lists) and the SSO state cookie
// name (`rpe_*` vs `rpl_*`). Both are now config, and env reads
// (import.meta.env.PROD / VITE_RPID_UI_URL) stay in the app so this
// module is pure + testable.

export interface SessionConfig {
  // Identifies the calling app to RPID's authorize endpoint.
  clientName: string
  // SSO `state` cookie name. Apps resolve the `__Host-` (prod) vs bare
  // (http://localhost dev) variant themselves — footgun #20: `__Host-`
  // cookies silently drop on plain http.
  stateCookieName: string
  // RPID's hosted UI origin. Cross-subdomain so it can't be derived;
  // the app passes its build-time VITE_RPID_UI_URL.
  rpidUiUrl: string
  // Whether to append `; Secure` to the state cookie (import.meta.env.PROD).
  secureCookie: boolean
  // Probes the app session — the app's typed `getSession()` over its
  // CsrfClient. Resolves the authenticated user id; rejects with
  // ApiError(401) when unauthenticated. May also carry the shared
  // cross-app settings doc (theme etc.) folded in by the app's BFF; the
  // app hydrates theme as a side-effect of its own getSession, web-kit
  // just passes the doc through on SessionState for any consumer. May
  // also carry the user's RPID profile (avatar + name) for the user bar.
  getSession: () => Promise<{
    user_id: string
    settings?: Record<string, unknown>
    profile?: SessionProfile | null
  }>
  // Defaults to '/sso/callback'.
  callbackPath?: string
  // SSO state cookie lifetime; defaults to 10 minutes.
  stateTtlSeconds?: number
  // Full-page navigation primitive; defaults to `window.location.assign`.
  // Injectable so the SSO bounce is unit-testable without stubbing the
  // non-configurable jsdom `location`.
  navigate?: (url: string) => void
}

// The signed-in user's RPID profile, folded into the session probe by the
// app's BFF for the user bar. `username` is the (non-unique) display name.
// Any field may be null when RPID has no value (or the fold-in degraded).
export interface SessionProfile {
  username: string | null
  first_name: string | null
  last_name: string | null
  picture_url: string | null
  email: string | null
}

export interface SessionState {
  status: 'loading' | 'authenticated' | 'unauthenticated' | 'error'
  userId: string | null
  error: string | null
  // Shared cross-app settings doc when the BFF folded it in. Three states:
  // `null` = not yet probed (or unauthenticated); `{}` = probed but the
  // user has no stored settings; a populated object otherwise.
  settings: Record<string, unknown> | null
  // The user's RPID profile when the BFF folded it in; `null` when not
  // probed, unauthenticated, or the fold-in degraded.
  profile: SessionProfile | null
}

export interface Session {
  useSession: () => SessionState
  beginSso: (returnTo?: string, opts?: { prompt?: 'none' }) => void
  readStateCookie: () => string | null
  clearStateCookie: () => void
  stateCookieName: string
}

// Best-effort HTTP status off a thrown value: `ApiError.status`, or a
// numeric `status` on any error-shaped object. `undefined` when absent.
function errorStatus(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.status
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status
    if (typeof status === 'number') return status
  }
  return undefined
}

// Backoff before the single automatic re-probe after a transient mount
// failure. Short enough to recover quickly, long enough to let a blip pass.
const REPROBE_BACKOFF_MS = 1500

function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function createSession(config: SessionConfig): Session {
  const callbackPath = config.callbackPath ?? '/sso/callback'
  const stateTtlSeconds = config.stateTtlSeconds ?? 10 * 60
  const secureSuffix = config.secureCookie ? '; Secure' : ''
  const navigate = config.navigate ?? ((url: string) => window.location.assign(url))

  function readStateCookie(): string | null {
    const prefix = `${config.stateCookieName}=`
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim()
      if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length)
    }
    return null
  }

  function clearStateCookie(): void {
    document.cookie =
      `${config.stateCookieName}=; Path=/; Max-Age=0; SameSite=Lax${secureSuffix}`
  }

  // Begin the SSO bootstrap: mint a fresh state nonce, persist it to
  // the state cookie, and hand control to RPID's authorize page. Full
  // navigation (window.location) because we cross origins to RPID.
  // `returnTo` defaults to the current location so the user lands back
  // where they started after sign-in.
  function beginSso(returnTo?: string, opts?: { prompt?: 'none' }): void {
    const nonce = generateNonce()
    document.cookie =
      `${config.stateCookieName}=${nonce}; Path=/; Max-Age=${stateTtlSeconds}; ` +
      `SameSite=Lax${secureSuffix}`

    const callbackUrl = new URL(callbackPath, window.location.origin)
    callbackUrl.searchParams.set('dest', returnTo ?? window.location.href)

    const authorize = new URL('/sso/authorize', config.rpidUiUrl)
    authorize.searchParams.set('client', config.clientName)
    authorize.searchParams.set('return_to', callbackUrl.toString())
    authorize.searchParams.set('state', nonce)
    if (opts?.prompt === 'none') authorize.searchParams.set('prompt', 'none')
    navigate(authorize.toString())
  }

  // Probe the app session. A 401 (or a 503 from an RPID hiccup
  // propagated through the session middleware) is reported distinctly
  // so callers can choose to bounce to SSO vs. show a transient error.
  //
  // Recovery from a transient (non-401) probe failure: the initial mount
  // probe gets a single automatic re-probe after a short backoff, and
  // thereafter we re-probe on tab refocus (`visibilitychange`→visible)
  // and on regained connectivity (`online`) — but ONLY while the last
  // probe is in the error state, so an authenticated tab isn't re-probing
  // RPID on every focus. A 401 (unauthenticated) is a settled state and
  // is not re-probed; the app drives the SSO bounce from there.
  function useSession(): SessionState {
    const [state, setState] = useState<SessionState>({
      status: 'loading',
      userId: null,
      error: null,
      settings: null,
      profile: null,
    })

    // Mirror the committed status so the event handlers below can gate on
    // it without being re-bound every render (the effect runs once).
    const statusRef = useRef(state.status)
    statusRef.current = state.status

    useEffect(() => {
      let cancelled = false
      let retryTimer: ReturnType<typeof setTimeout> | undefined

      const apply = (err: unknown): void => {
        // Structural 401 check (not just `instanceof ApiError`): an app
        // might wire a `getSession` whose rejection carries a numeric
        // `status` from a different error class. A 401 must still bounce
        // to SSO rather than render the transient-error panel.
        if (errorStatus(err) === 401) {
          setState({
            status: 'unauthenticated',
            userId: null,
            error: null,
            settings: null,
            profile: null,
          })
        } else {
          const message = err instanceof Error ? err.message : 'Unknown error.'
          setState({
            status: 'error',
            userId: null,
            error: message,
            settings: null,
            profile: null,
          })
        }
      }

      // Single-flight: a `visibilitychange` and an `online` event can fire
      // back-to-back; without this guard two probes race and a late failure
      // could clobber an already-recovered state.
      let probeInFlight = false
      const probe = (onTransientError?: () => void): void => {
        if (probeInFlight) return
        probeInFlight = true
        config
          .getSession()
          .then((s) => {
            if (cancelled) return
            setState({
              status: 'authenticated',
              userId: s.user_id,
              error: null,
              settings: s.settings ?? null,
              profile: s.profile ?? null,
            })
          })
          .catch((err: unknown) => {
            if (cancelled) return
            apply(err)
            if (errorStatus(err) !== 401) onTransientError?.()
          })
          .finally(() => {
            probeInFlight = false
          })
      }

      // Initial probe: a single backoff re-probe on a transient failure
      // smooths over a momentary 5xx/network blip without a manual reload.
      probe(() => {
        retryTimer = setTimeout(() => {
          if (!cancelled) probe()
        }, REPROBE_BACKOFF_MS)
      })

      const reprobeIfErrored = (): void => {
        if (!cancelled && statusRef.current === 'error') probe()
      }
      const onVisibility = (): void => {
        if (document.visibilityState === 'visible') reprobeIfErrored()
      }
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('online', reprobeIfErrored)

      return () => {
        cancelled = true
        if (retryTimer) clearTimeout(retryTimer)
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('online', reprobeIfErrored)
      }
    }, [])

    return state
  }

  return {
    useSession,
    beginSso,
    readStateCookie,
    clearStateCookie,
    stateCookieName: config.stateCookieName,
  }
}
