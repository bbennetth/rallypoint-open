import { useEffect, type ReactNode } from 'react'
import type { Session } from './session.js'
import { identify, analyticsPersonProps } from './analytics.js'

// Auth gate for the app's session-scoped routes. While the session
// probe is in flight we render a neutral loading state. On
// unauthenticated we kick off the SSO bootstrap (full cross-origin
// redirect to RPID) and render a redirecting state in the meantime. A
// 5xx/transport error is surfaced distinctly with a retry rather than
// silently bouncing.
//
// Styled with shared design-system tokens (var(--*) from
// `@rallypoint/ui/theme.css`) via inline styles so the gate needs
// neither Tailwind nor a router — works in every app regardless of its
// react-router version. Bind it once per app:
//   export const RequireSession = createRequireSession(session)

export interface RequireSessionProps {
  children: (userId: string) => ReactNode
}

export function createRequireSession(session: Session) {
  return function RequireSession({ children }: RequireSessionProps) {
    const { status, userId, error, profile } = session.useSession()

    useEffect(() => {
      if (status === 'unauthenticated') session.beginSso()
    }, [status])

    // Tie analytics events / session replays / captured errors to the
    // signed-in user. No-op in FOSS/dev builds (the seam resolves to the
    // noop stub). resetAnalytics() on logout lives in each app's signout()
    // helper. `profile` is in the dep list to satisfy exhaustive-deps, but
    // useSession resolves it once (its own effect has [] deps), so this runs
    // a single time per authenticated probe — and `identify` is idempotent,
    // so a re-fire with the same id is harmless either way.
    useEffect(() => {
      if (status === 'authenticated' && userId) {
        identify(userId, analyticsPersonProps(profile))
      }
    }, [status, userId, profile])

    if (status === 'authenticated') return <>{children(userId!)}</>

    return (
      <main
        style={{
          minHeight: '100dvh',
          background: 'var(--bg)',
          color: 'var(--ink)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
        }}
      >
        <div style={{ maxWidth: '28rem', width: '100%', textAlign: 'center' }}>
          {(status === 'loading' || status === 'unauthenticated') && (
            <p style={{ color: 'var(--ink-dim)', fontSize: 14 }} className="mono">
              {status === 'loading' ? 'Checking your session…' : 'Redirecting to sign in…'}
            </p>
          )}
          {status === 'error' && (
            <div
              style={{
                border: '1.5px solid var(--hot)',
                background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
                padding: '1rem',
                textAlign: 'left',
              }}
            >
              <h1 className="display" style={{ fontSize: 18, color: 'var(--ink)', margin: 0 }}>
                Couldn&apos;t reach the server
              </h1>
              <p style={{ marginTop: 8, fontSize: 14, color: 'var(--ink-dim)' }}>
                {error ?? 'Unknown error.'}
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="btn-ghost"
                style={{ marginTop: 16 }}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </main>
    )
  }
}
