import { useEffect, useState } from 'react'
import {
  CONNECTING_STALE_MS,
  decideConnectionView,
  type ConnectionView,
} from '../lib/connection-status.js'
import { useConnectionStore } from './connection.js'

// React hook for the chrome surfaces (BrandLockup compass dot,
// AppSwitcher, headers) — combines the connection store + the
// CONNECTING_STALE_MS staleness watchdog and returns the resolved
// `ConnectionView`. Ported from festival-planner's
// src/hooks/useConnectionView.ts, simplified: no group-store
// dependency for `lastSyncedAt` — rallypoint-core's chrome
// currently consumes only `phase` + `color` + `title`, and the
// title prefers the welcome-frame timestamp held inside `synced` →
// `syncLostAt` transitions. Callers that later want a per-event
// `lastSyncedAt` label can wrap this and merge in their own state.
//
// The watchdog rearms whenever `online` or `synced` flips, so a
// reconnect kicks the timer back to zero — exactly the festival-
// planner behaviour.

export interface UseConnectionViewOptions {
  /** Optional welcome-frame timestamp for the title label. */
  lastSyncedAt?: number | null
}

export function useConnectionView(opts: UseConnectionViewOptions = {}): ConnectionView {
  const online = useConnectionStore((s) => s.online)
  const synced = useConnectionStore((s) => s.synced)
  const syncLostAt = useConnectionStore((s) => s.syncLostAt)
  const bootstrapStale = useConnectionStore((s) => s.bootstrapStale)

  const [connectingStale, setConnectingStale] = useState(false)
  useEffect(() => {
    if (!online || synced) {
      setConnectingStale(false)
      return
    }
    setConnectingStale(false)
    const t = window.setTimeout(() => setConnectingStale(true), CONNECTING_STALE_MS)
    return () => window.clearTimeout(t)
  }, [online, synced])

  return decideConnectionView({
    online,
    synced,
    lastSyncedAt: opts.lastSyncedAt ?? null,
    syncLostAt,
    connectingStale: connectingStale || bootstrapStale,
  })
}
