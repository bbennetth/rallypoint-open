import { useEffect, useRef, useState } from 'react'
import type { SessionProfile } from '@rallypoint/shared'
import { ApiError } from './csrf.js'
import { analyticsPersonProps, identify } from './analytics.js'

// Re-exported so browser consumers keep importing `SessionProfile` from
// `@rallypoint/web-kit`; the canonical definition lives in
// `@rallypoint/shared` so the *-api session probes share it (#456).
export type { SessionProfile }

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
// User-facing error copy is restricted to a fixed set of local strings.
// `err.message` can carry server-supplied text (an ApiError body, a
// proxy's HTML error page) — rendering that verbatim in the auth gate
// is a phishing-copy surface, so it never reaches the UI. The raw
// error is still available to callers via the console for debugging.
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message === 'Session check timed out.') {
    return 'Session check timed out.'
  }
  const status = errorStatus(err)
  if (typeof status === 'number') {
    return `The sign-in service responded with an error (HTTP ${status}).`
  }
  return 'Could not reach the sign-in service.'
}

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
// The initial mount probe also *defers* its error commit until this re-probe
// runs (see `deferErrorCommit` in `probe`): a one-off blip — e.g. a service
// worker starving the probe for seconds during a deploy rollout — stays on
// the neutral "Checking your session…" spinner and self-heals, instead of
// flashing the "Couldn't reach the server" panel before the retry's shot.
const REPROBE_BACKOFF_MS = 1500

// Backstop timeout for a single session probe. A probe whose underlying
// fetch never settles wedges the gate on 'loading' forever — the classic
// frozen-PWA case, where iOS suspends the app mid-request and the dangling
// promise is never resolved or rejected on resume. When the watchdog fires
// we treat the probe as a transient failure so the recovery machinery
// (backoff re-probe, focus/online re-probe) takes over instead of leaving
// the user stuck on "Checking your session…" until they force-quit.
const PROBE_TIMEOUT_MS = 10_000

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
  // probe gets a single automatic re-probe after a short backoff. That first
  // failure is committed *silently* — the gate stays on 'loading', not
  // 'error' — so a one-off blip (e.g. a service worker starving the probe
  // during a deploy) never flashes the error panel; only if the backoff
  // re-probe ALSO fails does 'error' commit (see `deferErrorCommit`).
  // Thereafter we re-probe on tab refocus (`visibilitychange`→visible)
  // and on regained connectivity (`online`) — while the last probe is
  // either still loading or in the error state, so an authenticated tab
  // isn't re-probing RPID on every focus. Those re-probes do NOT defer:
  // a failure after the app is up commits 'error' immediately. Including
  // the `loading` case in the re-probe gate is what unwedges a PWA that
  // iOS froze mid-probe: the in-flight fetch is left
  // dangling on resume, so the focus event fires a fresh, superseding
  // probe (and a per-probe watchdog backstops the case where no focus
  // event arrives). A 401 (unauthenticated) is a settled state and is not
  // re-probed; the app drives the SSO bounce from there.
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
          console.error('[web-kit/session] probe failed:', err)
          setState({
            status: 'error',
            userId: null,
            error: safeErrorMessage(err),
            settings: null,
            profile: null,
          })
        }
      }

      // Per-probe sequence token instead of a boolean single-flight guard.
      // A frozen-PWA probe can be left dangling — its fetch never resolves
      // or rejects — so a boolean guard would stay stuck `true` and block
      // recovery forever. The sequence lets a newer probe supersede an
      // older one: only the latest probe may commit state, and a stale
      // probe that later resurrects is ignored (so it can't clobber an
      // already-recovered session). This also subsumes the old single-
      // flight role — a `visibilitychange` and an `online` firing back-to-
      // back start two probes, but only the newer one's result lands.
      let probeSeq = 0
      let activeWatchdog: ReturnType<typeof setTimeout> | undefined
      const probe = (opts?: {
        onTransientError?: () => void
        deferErrorCommit?: boolean
      }): void => {
        const onTransientError = opts?.onTransientError
        // When set (the initial mount probe only), a transient failure does
        // NOT commit 'error' — the gate stays on 'loading' and the single
        // backoff re-probe runs first. Only if that re-probe also fails does
        // the panel surface. Keeps a one-off deploy-rollout blip invisible
        // while still recovering hands-free.
        const deferErrorCommit = opts?.deferErrorCommit ?? false
        const seq = ++probeSeq
        let settled = false
        const commit = (run: () => void): void => {
          // Drop the result of a superseded/stale probe and of any
          // post-unmount settle.
          if (cancelled || seq !== probeSeq || settled) return
          settled = true
          if (activeWatchdog) clearTimeout(activeWatchdog)
          run()
        }

        // Transient (non-401) failure path shared by the watchdog and the
        // catch: commit 'error' unless this probe defers, and always fire the
        // recovery hook so a deferred probe still schedules its backoff retry.
        const failTransient = (err: unknown): void => {
          if (!deferErrorCommit) apply(err)
          onTransientError?.()
        }

        // Watchdog: a probe that never settles is treated as a transient
        // failure so the gate self-heals instead of wedging on 'loading'.
        // A new probe supersedes the previous one's watchdog.
        if (activeWatchdog) clearTimeout(activeWatchdog)
        activeWatchdog = setTimeout(() => {
          commit(() => failTransient(new Error('Session check timed out.')))
        }, PROBE_TIMEOUT_MS)

        config
          .getSession()
          .then((s) => {
            commit(() => {
              // A recovery (e.g. a focus/online re-probe that lands before
              // the mount probe's backoff fires) cancels the pending backoff
              // so we don't re-hit the session endpoint after we're already
              // authenticated. Only on success — failure paths keep the
              // backoff as the automatic recovery net.
              if (retryTimer) clearTimeout(retryTimer)
              // Link this browser's analytics events to the RPID user, the
              // same way id-web's useSessionClient does on its own probe.
              // Re-probes (focus/online) re-call identify with the same
              // distinct_id, which posthog-js treats as a no-op.
              identify(s.user_id, analyticsPersonProps(s.profile))
              setState({
                status: 'authenticated',
                userId: s.user_id,
                error: null,
                settings: s.settings ?? null,
                profile: s.profile ?? null,
              })
            })
          })
          .catch((err: unknown) => {
            commit(() => {
              // A 401 is a settled 'unauthenticated' result: it commits
              // immediately (never deferred) and is never retried — the app
              // drives the SSO bounce from there.
              if (errorStatus(err) === 401) apply(err)
              else failTransient(err)
            })
          })
      }

      // Initial probe: defer the error commit and, on a transient failure,
      // schedule a single backoff re-probe that smooths over a momentary
      // 5xx/network blip without a manual reload. The re-probe does NOT defer
      // — a second consecutive failure surfaces the error panel.
      probe({
        deferErrorCommit: true,
        onTransientError: () => {
          retryTimer = setTimeout(() => {
            if (!cancelled) probe()
          }, REPROBE_BACKOFF_MS)
        },
      })

      // Re-probe when the app returns to the foreground or regains
      // connectivity AND the last probe hasn't settled into a good state.
      // 'loading' is included alongside 'error': a PWA frozen mid-probe
      // resumes here with a possibly-dead in-flight request, so a fresh
      // probe (which supersedes the stale one via the sequence token)
      // recovers it immediately rather than waiting out the watchdog.
      // 'authenticated'/'unauthenticated' are settled states and are never
      // re-probed — a healthy tab won't re-hit RPID on every focus, and a
      // 401 keeps driving the SSO bounce.
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
        if (retryTimer) clearTimeout(retryTimer)
        if (activeWatchdog) clearTimeout(activeWatchdog)
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('online', reprobeIfStuck)
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
