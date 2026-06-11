import { useCallback, useEffect, useState } from 'react'
import { Banner } from '@rallypoint/ui'
import { api } from '../api/client.js'
import { appInitial, type LauncherApp } from '../lib/launcher.js'

// App grid for RPID Web v2 (#189). Fetches the apps the user can
// launch from GET /api/v1/ui/apps and renders a tile per app. Launch
// navigates to the app's origin; the target app's RequireSession then
// runs the existing SSO bounce against the live RPID session and mints
// a code — no new launch protocol here.

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; apps: LauncherApp[] }

export function AppLauncher() {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setTick((n) => n + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    api.get<{ apps: LauncherApp[] }>('/api/v1/ui/apps').then((res) => {
      if (cancelled) return
      if (res.ok) {
        setState({ status: 'ready', apps: res.data.apps })
      } else {
        setState({ status: 'error', message: res.error.message })
      }
    })
    return () => {
      cancelled = true
    }
  }, [tick])

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="display text-2xl" style={{ marginBottom: 4 }}>
        Your apps
      </h1>
      <p className="text-sm" style={{ color: 'var(--ink-dim)', marginBottom: 24 }}>
        Launch any Rallypoint app — you're already signed in.
      </p>

      {state.status === 'loading' ? (
        <Banner tone="info">Loading your apps…</Banner>
      ) : null}

      {state.status === 'error' ? (
        <div style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
          <Banner tone="error">{state.message}</Banner>
          <button type="button" className="underline" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}

      {state.status === 'ready' && state.apps.length === 0 ? (
        <Banner tone="info">No apps are available on this deployment yet.</Banner>
      ) : null}

      {state.status === 'ready' && state.apps.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3" style={{ listStyle: 'none', padding: 0 }}>
          {state.apps.map((app) => (
            <li key={app.client}>
              <a
                href={app.url}
                className="flex items-center gap-4 rounded-lg p-4"
                style={{
                  border: '1px solid var(--line)',
                  background: 'var(--surface)',
                  textDecoration: 'none',
                  color: 'var(--ink)',
                }}
              >
                <span
                  aria-hidden="true"
                  className="display flex items-center justify-center"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    background: 'var(--accent-soft)',
                    color: 'var(--ink)',
                    fontSize: 18,
                    flexShrink: 0,
                  }}
                >
                  {appInitial(app)}
                </span>
                <span style={{ display: 'grid' }}>
                  <span style={{ fontSize: 15 }}>{app.name}</span>
                  <span className="text-sm" style={{ color: 'var(--ink-dim)' }}>
                    Launch
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
