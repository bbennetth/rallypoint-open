import { useEffect, useRef, useState } from 'react'
import { ApiError } from './csrf.js'

// Shared SSO callback landing page (R2 dedup — design §3.13). RPID's
// /sso/authorize redirect lands here at /sso/callback?code&state&dest; we POST
// code+state to the app's exchange endpoint, which validates state against the
// cookie, swaps the code for an RPID session bearer, seals it, and sets the app
// session cookie.
//
// Router-agnostic by design (like the rest of web-kit): reads the query from
// window.location rather than react-router, so every app can use it regardless
// of its router version. Each app binds it with its redirect target + display
// name and passes its own exchange/cookie helpers.
//
// On ANY exchange failure we show the error panel — never a silent redirect.
// A silent replace on sso_* codes hid the real error from the user and from
// error-tracking tooling; surfacing it gives actionable feedback (audit P2).
// A stale/replayed code just means the user re-enters the flow from the app's
// auth gate.

export interface SsoCallbackPageProps {
  /** Display name in the "Connecting your Rallypoint ID to <appName>." line. */
  appName: string
  /** Same-origin fallback destination + the error panel's "Try again" href. */
  defaultRedirect: string
  /** The app's exchange call (POST /sso/exchange); throws ApiError on failure. */
  exchangeSso: (code: string, state: string) => Promise<void>
  /** Clears the single-use SSO state cookie (the app's web-kit session helper). */
  clearStateCookie: () => void
  /** Optional <main> padding override for a standalone route with no app shell. */
  mainPadding?: string
}

type Phase = { kind: 'exchanging' } | { kind: 'error'; code: string; message: string }

// `dest` rides in on the URL, so an attacker could point it at an external
// origin (open redirect after the session cookie is set). Honour only
// same-origin destinations; anything else falls back to the app's gated home.
export function safeDest(raw: string | null, fallback: string): string {
  if (!raw) return fallback
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    return fallback
  }
}

// Map an exchange rejection to the {code, message} the error panel renders.
// `instanceof ApiError` is reliable because every app throws THIS class: each
// app's lib/api.ts re-exports ApiError from @rallypoint/web-kit, so there is a
// single module instance across the bundle.
export function describeExchangeError(err: unknown): { code: string; message: string } {
  return {
    code: err instanceof ApiError ? err.code : 'unexpected_error',
    message: err instanceof Error ? err.message : 'Unknown error.',
  }
}

export function SsoCallbackPage({
  appName,
  defaultRedirect,
  exchangeSso,
  clearStateCookie,
  mainPadding,
}: SsoCallbackPageProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'exchanging' })
  // The SSO code is single-use; guard against React StrictMode's double effect
  // invocation so we don't exchange (and 409) twice.
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const dest = safeDest(params.get('dest'), defaultRedirect)

    if (!code || !state) {
      setPhase({
        kind: 'error',
        code: 'missing_params',
        message: 'The sign-in link is missing required parameters.',
      })
      return
    }

    exchangeSso(code, state)
      .then(() => {
        clearStateCookie()
        // Full navigation so the just-set session cookie rides the
        // destination's first request.
        window.location.replace(dest)
      })
      .catch((err: unknown) => {
        clearStateCookie()
        setPhase({ kind: 'error', ...describeExchangeError(err) })
      })
    // Deps are listed to satisfy exhaustive-deps, but they're stable per-app
    // module values (a literal redirect + imported helpers), so this effect
    // runs once on mount; the `ran` ref enforces a single exchange even under
    // StrictMode's double-invoke.
  }, [defaultRedirect, exchangeSso, clearStateCookie])

  return (
    <main
      className="page-pad"
      style={{
        minHeight: '100dvh',
        background: 'var(--bg)',
        color: 'var(--ink)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...(mainPadding ? { padding: mainPadding } : {}),
      }}
    >
      <div
        style={{ maxWidth: '28rem', width: '100%', textAlign: 'center', display: 'grid', gap: 12 }}
      >
        {phase.kind === 'exchanging' && (
          <>
            <h1 className="display" style={{ fontSize: 24, margin: 0 }}>
              Signing you in…
            </h1>
            <p className="mono" style={{ color: 'var(--ink-dim)', fontSize: 13 }}>
              Connecting your Rallypoint ID to {appName}.
            </p>
          </>
        )}
        {phase.kind === 'error' && (
          <div
            style={{
              border: '1.5px solid var(--hot)',
              background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
              padding: '1rem',
              textAlign: 'left',
              // A long unbroken server `code` must wrap, not overflow
              // the fixed-width panel.
              overflowWrap: 'break-word',
            }}
          >
            <h1 className="display" style={{ fontSize: 18, color: 'var(--ink)', margin: 0 }}>
              Could not sign you in
            </h1>
            <p style={{ marginTop: 8, fontSize: 14, color: 'var(--ink-dim)' }}>
              <strong className="mono">{phase.code}</strong>: {phase.message}
            </p>
            <a
              href={defaultRedirect}
              className="mono"
              style={{ marginTop: 16, display: 'inline-block', fontSize: 13, color: 'var(--acid)' }}
            >
              Try again
            </a>
          </div>
        )}
      </div>
    </main>
  )
}
