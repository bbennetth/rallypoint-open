import { useEffect, useState, useCallback } from 'react'
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

  useEffect(() => {
    let cancelled = false
    api.get<SessionPayload>('/api/v1/ui/session').then((res) => {
      if (cancelled) return
      if (res.ok) {
        ensureWriteThroughSubscription()
        hydrateTheme(res.data.settings)
        writeThroughEnabled = true
        // distinct_id is the stable RPID user id (`sub`). UserInfo.name is the
        // display username column (=== preferred_username, see #295), so it
        // maps to `username` — analyticsPersonProps prefers first+last for the
        // person `name` and only falls back to it.
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
    return () => {
      cancelled = true
    }
  }, [tick])

  const refetch = useCallback(() => setTick((n) => n + 1), [])
  return { ...state, refetch }
}
