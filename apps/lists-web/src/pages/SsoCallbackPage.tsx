import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError, exchangeSso } from '../lib/api.js'
import { clearStateCookie } from '../lib/session.js'

// Landing point for RPID's /sso/authorize redirect (design §3.13).
// RPID sends us back to /sso/callback?code=<raw>&state=<nonce>&dest=<url>.
// We POST the code+state to lists-api's exchange endpoint, which
// validates state against the cookie, swaps the code for an RPID
// session bearer, seals it, and sets our lists session cookie.
//
// Failure handling: any sso_* error (stale/replayed code, state
// mismatch) is non-fatal — we bounce back to `dest`, whose auth gate
// re-enters the SSO flow with a fresh code. Step 1 is the entry
// point, so a failed exchange just means "start over".

type Phase =
  | { kind: 'exchanging' }
  | { kind: 'error'; code: string; message: string }

// `dest` rides in on the URL, so an attacker could craft a callback
// link pointing it at an external origin (open redirect after the
// session cookie is set). Only honour same-origin destinations;
// anything else falls back to the app's gated home.
function safeDest(raw: string | null): string {
  if (!raw) return '/me/lists'
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return '/me/lists'
    return url.pathname + url.search + url.hash
  } catch {
    return '/me/lists'
  }
}

export function SsoCallbackPage() {
  const [params] = useSearchParams()
  const [phase, setPhase] = useState<Phase>({ kind: 'exchanging' })
  // The SSO code is single-use; guard against React StrictMode's
  // double effect invocation so we don't exchange (and 409) twice.
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const code = params.get('code')
    const state = params.get('state')
    const dest = safeDest(params.get('dest'))

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
        // Full navigation so the just-set session cookie is sent on
        // the destination's first request.
        window.location.replace(dest)
      })
      .catch((err: unknown) => {
        clearStateCookie()
        if (err instanceof ApiError && err.code.startsWith('sso_')) {
          window.location.replace(dest)
          return
        }
        setPhase({
          kind: 'error',
          code: err instanceof ApiError ? err.code : 'unexpected_error',
          message: err instanceof Error ? err.message : 'Unknown error.',
        })
      })
  }, [params])

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
      }}
    >
      <div style={{ maxWidth: '28rem', width: '100%', textAlign: 'center', display: 'grid', gap: 12 }}>
        {phase.kind === 'exchanging' && (
          <>
            <h1 className="display" style={{ fontSize: 24, margin: 0 }}>
              Signing you in…
            </h1>
            <p className="mono" style={{ color: 'var(--ink-dim)', fontSize: 13 }}>
              Connecting your Rallypoint ID to Lists.
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
            }}
          >
            <h1 className="display" style={{ fontSize: 18, color: 'var(--ink)', margin: 0 }}>
              Could not sign you in
            </h1>
            <p style={{ marginTop: 8, fontSize: 14, color: 'var(--ink-dim)' }}>
              <strong className="mono">{phase.code}</strong>: {phase.message}
            </p>
            <a
              href="/me/lists"
              className="mono"
              style={{
                marginTop: 16,
                display: 'inline-block',
                fontSize: 13,
                color: 'var(--acid)',
              }}
            >
              Try again
            </a>
          </div>
        )}
      </div>
    </main>
  )
}
