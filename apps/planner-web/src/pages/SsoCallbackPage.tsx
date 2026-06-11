import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError, exchangeSso } from '../lib/api.js'
import { clearStateCookie } from '../lib/session.js'

// Landing point for RPID's /sso/authorize redirect (design §3.13).
// RPID sends us back to /sso/callback?code=<raw>&state=<nonce>&dest=<url>.
// We POST the code+state to planner-api's exchange endpoint, which
// validates state against the cookie, swaps the code for an RPID
// session bearer, seals it, and sets our planner session cookie.

type Phase =
  | { kind: 'exchanging' }
  | { kind: 'error'; code: string; message: string }

function safeDest(raw: string | null): string {
  if (!raw) return '/me'
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return '/me'
    return url.pathname + url.search + url.hash
  } catch {
    return '/me'
  }
}

export function SsoCallbackPage() {
  const [params] = useSearchParams()
  const [phase, setPhase] = useState<Phase>({ kind: 'exchanging' })
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
              Connecting your Rallypoint ID to Planner.
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
              href="/me"
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
