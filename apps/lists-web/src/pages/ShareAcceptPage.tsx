import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ApiError, acceptListInvite } from '../lib/api.js'

// #128 — Landing page for share-by-email invite codes. Path:
// `/share/:code`. The page auto-submits the code to
// `POST /api/v1/ui/lists/invites/accept` (RequireSession wraps it, so
// the SSO flow runs first if the visitor isn't signed in — the
// `return_to=...` plumbing inside RequireSession brings them back
// here post-sign-in), then navigates to the now-shared list.
//
// The previous SsoCallbackPage pattern is reused for the loading +
// error shell; we don't render the chrome since this is a single-
// purpose handoff.

type Phase =
  | { kind: 'accepting' }
  | { kind: 'error'; code: string; message: string }

export function ShareAcceptPage() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>({ kind: 'accepting' })
  // Single-use: React StrictMode double-mounts effects in dev; guard
  // so we don't submit the same code twice and hit
  // `invite_already_consumed` on our own retry.
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    if (!code) {
      setPhase({
        kind: 'error',
        code: 'missing_code',
        message: 'The share link is missing its code.',
      })
      return
    }
    acceptListInvite(code)
      .then((res) => {
        navigate(`/me/lists/${res.list_id}`, { replace: true })
      })
      .catch((err: unknown) => {
        setPhase({
          kind: 'error',
          code: err instanceof ApiError ? err.code : 'unexpected_error',
          message: err instanceof Error ? err.message : 'Unknown error.',
        })
      })
  }, [code, navigate])

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
        {phase.kind === 'accepting' && (
          <>
            <h1 className="display" style={{ fontSize: 24, margin: 0 }}>
              Joining the list…
            </h1>
            <p className="mono" style={{ color: 'var(--ink-dim)', fontSize: 13 }}>
              One moment.
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
              Could not join
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
              Back to my lists
            </a>
          </div>
        )}
      </div>
    </main>
  )
}
