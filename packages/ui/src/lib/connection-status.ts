// Connection status tri-state binding shared by the chrome surfaces
// (the BrandLockup compass dot, AppSwitcher header). Ported verbatim
// from festival-planner's src/lib/connectionStatus.ts — the chrome
// behaviour should feel identical across rallypoint-core and
// festival-planner so an attendee moving between them never wonders
// about the dot colour.
//
// Reading both `online` (navigator.onLine, cheap but lies on captive
// portals) and `synced` (the SSE welcome-frame gate) is what lets the
// dot turn amber when the OS thinks we're online but the realtime
// channel has died — the exact drift that otherwise produces "saved
// locally" toasts under a green dot.

export type ConnectionPhase = 'connected' | 'connecting' | 'offline'

export interface ConnectionView {
  phase: ConnectionPhase
  color: string
  title: string
}

export const CONNECTION_COLORS = {
  connected: '#22c55e',
  connecting: '#f59e0b',
  offline: '#ef4444',
} as const

/**
 * How long the indicator stays amber before flipping to red on a
 * device whose `navigator.onLine` reports `true` but whose realtime
 * stream has never welcomed (or has been unsynced too long). 3s was
 * too tight in festival-planner; cold-start handshake + service-side
 * warm-up + welcome routinely landed at 4–6s on cellular, producing
 * false-red flaps.
 */
export const CONNECTING_STALE_MS = 8000

/**
 * Hysteresis grace window: if the realtime stream lost sync within
 * this many ms, prefer amber `connecting` over red `offline` even
 * after the stale watchdog fires. Stops a brief reconnect (token
 * refresh, network handover, post-wake handshake) from flapping the
 * dot through red. The `!online` short-circuit (OS-level offline)
 * bypasses this — that signal is authoritative.
 *
 * Measured against `syncLostAt` (the connection-store timestamp of
 * the most recent `synced: true → false` transition), NOT
 * `lastSyncedAt` (the welcome timestamp) — `lastSyncedAt` doesn't
 * refresh during a healthy session, so a 30-min-old session that
 * briefly drops wouldn't land in the grace at all without the
 * dedicated lost-at marker.
 *
 * 30s comfortably covers slow 3G recovery (~10–12s for pong-timeout
 * + handshake). Caps the worst-case stuck-online wait at
 * CONNECTING_STALE_MS + 30s ≈ 38s.
 */
export const RECENTLY_SYNCED_GRACE_MS = 30_000

export function wasRecentlyConnected(
  syncLostAt: number | null,
  now: number = Date.now(),
): boolean {
  return syncLostAt != null && now - syncLostAt < RECENTLY_SYNCED_GRACE_MS
}

export function decideConnectionView(input: {
  online: boolean
  synced: boolean
  /**
   * Timestamp of the last welcome — used for the title label only.
   * Hysteresis is gated on `syncLostAt`, not this.
   */
  lastSyncedAt: number | null
  /**
   * Timestamp of the most recent `synced: true → false` transition,
   * or null. Drives the recently-connected grace; null means a cold
   * start with no prior session — no grace.
   */
  syncLostAt?: number | null
  connectingStale?: boolean
  now?: number
}): ConnectionView {
  const {
    online,
    synced,
    lastSyncedAt,
    syncLostAt = null,
    connectingStale = false,
    now = Date.now(),
  } = input
  const lastSyncedLabel =
    lastSyncedAt != null ? new Date(lastSyncedAt).toLocaleString() : null
  const recentlyConnected = wasRecentlyConnected(syncLostAt, now)

  if (!online || (!synced && connectingStale && !recentlyConnected)) {
    return {
      phase: 'offline',
      color: CONNECTION_COLORS.offline,
      title:
        lastSyncedLabel != null
          ? `Offline — last synced ${lastSyncedLabel}`
          : 'Offline — changes queue locally',
    }
  }

  if (!synced) {
    return {
      phase: 'connecting',
      color: CONNECTION_COLORS.connecting,
      title:
        lastSyncedLabel != null
          ? `Reconnecting — last synced ${lastSyncedLabel}`
          : 'Reconnecting',
    }
  }

  return {
    phase: 'connected',
    color: CONNECTION_COLORS.connected,
    title:
      lastSyncedLabel != null
        ? `Connected — last synced ${lastSyncedLabel}`
        : 'Connected',
  }
}
