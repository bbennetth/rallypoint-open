import { create } from 'zustand'

// Connection state store ported from festival-planner's
// src/store/connection.ts. Reading both `online` and `synced` lets
// the chrome distinguish OS-level disconnects from realtime drift,
// which is the thing that causes "silent failure" if the dot only
// follows navigator.onLine.

export interface ConnectionState {
  /** Network connectivity from navigator.onLine + online/offline events. */
  online: boolean
  /**
   * True once the realtime stream's welcome signal has landed and the
   * client's cached state can be trusted. Cleared on disconnect so a
   * stale client doesn't happily edit stale data.
   */
  synced: boolean
  /**
   * Timestamp (ms) of the most recent `synced: true → false`
   * transition, or `null` if currently synced or never synced this
   * session. Drives the `RECENTLY_SYNCED_GRACE_MS` hysteresis in
   * `decideConnectionView`: a brief disconnect during a long-lived
   * healthy session stays amber for the grace window instead of
   * flapping red.
   *
   * Auto-managed by `setSynced` — `false→null` on resync, `true→now`
   * on first drop; repeated `setSynced(false)` calls (e.g. a polling
   * loop on a dead socket) don't refresh the marker.
   */
  syncLostAt: number | null
  /**
   * True once the app's auth-bootstrap watchdog has tripped — i.e.
   * `navigator.onLine` reports `true` but the auth path hasn't
   * resolved within its timeout. `useConnectionView` ORs this with
   * its local in-session staleness watchdog so the chrome flips red
   * the instant the degraded shell renders, instead of waiting
   * another `CONNECTING_STALE_MS` for the local timer to arm at
   * mount.
   */
  bootstrapStale: boolean
  setOnline(v: boolean): void
  setSynced(v: boolean): void
  setBootstrapStale(v: boolean): void
}

const initialOnline = typeof navigator !== 'undefined' ? navigator.onLine : true

export const useConnectionStore = create<ConnectionState>()((set) => ({
  online: initialOnline,
  synced: false,
  syncLostAt: null,
  bootstrapStale: false,
  setOnline: (v) => set({ online: v }),
  setSynced: (v) =>
    set((prev) => {
      if (v) return { synced: true, syncLostAt: null }
      // Only stamp on the first true→false transition. Repeated
      // false→false calls must NOT refresh the marker, otherwise the
      // grace window would never expire.
      if (!prev.synced) return { synced: false }
      return { synced: false, syncLostAt: Date.now() }
    }),
  setBootstrapStale: (v) => set({ bootstrapStale: v }),
}))

// Non-hook selectors for module-level use.
export function selectCanEdit(s: ConnectionState): boolean {
  return s.online && s.synced
}

// One-shot installer that wires `navigator.onLine` + the `online` /
// `offline` window events to the store. Call once at app mount
// (browser-only; guard for SSR / node tests).
export function installConnectionListeners(): () => void {
  if (typeof window === 'undefined') return () => {}
  const { setOnline } = useConnectionStore.getState()
  const onOnline = () => setOnline(true)
  const onOffline = () => setOnline(false)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  return () => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  }
}
