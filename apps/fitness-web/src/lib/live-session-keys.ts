// Single owner of the in-flight live-session localStorage slots: the
// key constants, the live-session id generator, and the strength
// slot's read/write/clear operations (including the 24h staleness
// decision). The live pages persist/restore through here, the
// composer's "Start now" seeds the strength slot, ResumeSessionPill
// scans the keys, and the signout purge clears all three.

import {
  isLiveSessionStale,
  restoreStrengthSession,
  serializeStrengthSession,
  type StrengthSessionState,
} from '@rallypoint/fitness-shared'

export const STRENGTH_LS_KEY = 'rp-fitness-strength-session-current'
export const WOD_LS_KEY = 'rp-fitness-wod-session-current'
// Rep-entry engine (interval / max_reps_rounds) persists to its own key.
export const REP_LS_KEY = 'rp-fitness-wod-rep-session-current'

// Parking spot for a finished-but-not-yet-acked session: `saveToLog`
// clears the live slot right after the optimistic createWorkout()
// returns so a NEW session can use the slot immediately, but if the
// tmp id is still a tmp id the server hasn't confirmed the save yet.
// Rather than leave the slot occupied (blocking a new session) or wipe
// it outright (losing the session if the flush later 4xxs), the raw
// snapshot moves here until the create resolves or terminally fails.
export const PENDING_SAVE_LS_KEY = 'rp-fitness-pending-save'

/** Every live-session slot — the signout purge iterates this so a
 *  user-switch on a shared browser can't resurrect another user's
 *  session via the Resume pill. */
export const ALL_LIVE_SESSION_LS_KEYS = [
  STRENGTH_LS_KEY,
  WOD_LS_KEY,
  REP_LS_KEY,
  PENDING_SAVE_LS_KEY,
] as const

/** One parked session: `snapshot` is the raw serialized slot value
 *  (untyped here — we don't need to parse it to park/reopen it, only
 *  the owning page's restore* fn does that). */
export interface PendingSaveEntry {
  tmpId: string
  slotKey: string
  snapshot: string
  at: number
  /** Set when the create terminally failed but the slot was occupied by
   *  a NEWER session at reopen time — the snapshot stays parked and is
   *  restored lazily by restoreFailedPendingSaves() once the slot frees
   *  (restoring immediately would clobber the newer session). */
  failed?: boolean
}

const PENDING_SAVE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Pure core: drop entries older than 24h. Exported for unit tests that
 *  don't want to go through localStorage. */
export function pruneStalePendingSaves(
  entries: PendingSaveEntry[],
  nowMs: number,
): PendingSaveEntry[] {
  return entries.filter((e) => nowMs - e.at < PENDING_SAVE_MAX_AGE_MS)
}

function readPendingSaves(nowMs: number): PendingSaveEntry[] {
  try {
    const raw = window.localStorage.getItem(PENDING_SAVE_LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return pruneStalePendingSaves(parsed as PendingSaveEntry[], nowMs)
  } catch {
    return []
  }
}

function writePendingSaves(entries: PendingSaveEntry[]): void {
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(PENDING_SAVE_LS_KEY)
      return
    }
    window.localStorage.setItem(PENDING_SAVE_LS_KEY, JSON.stringify(entries))
  } catch {
    /* ignore */
  }
}

/** Snapshot the slot's current value into the pending-save marker, then
 *  clear the slot — a new session can reuse it immediately while the
 *  finished one waits for the server to ack. No-op (nothing to park) if
 *  the slot is already empty. */
export function markSessionPendingSave(slotKey: string, tmpId: string): void {
  try {
    const snapshot = window.localStorage.getItem(slotKey)
    if (snapshot == null) return
    const entries = readPendingSaves(Date.now()).filter((e) => e.tmpId !== tmpId)
    entries.push({ tmpId, slotKey, snapshot, at: Date.now() })
    writePendingSaves(entries)
    window.localStorage.removeItem(slotKey)
  } catch {
    /* ignore */
  }
}

/** Server acked the create — drop the marker without restoring anything. */
export function resolvePendingSave(tmpId: string): void {
  const entries = readPendingSaves(Date.now()).filter((e) => e.tmpId !== tmpId)
  writePendingSaves(entries)
}

/** The create terminally failed — write the parked snapshot back into
 *  its slot (so the Resume pill picks the session back up) and drop the
 *  marker. If a NEWER session has reoccupied the slot since parking,
 *  restoring now would clobber it — instead the entry is flagged
 *  `failed` and restored lazily by restoreFailedPendingSaves() the next
 *  time the slot reads empty. */
export function reopenPendingSave(tmpId: string): void {
  const entries = readPendingSaves(Date.now())
  const match = entries.find((e) => e.tmpId === tmpId)
  if (!match) return
  try {
    if (window.localStorage.getItem(match.slotKey) != null) {
      writePendingSaves(entries.map((e) => (e.tmpId === tmpId ? { ...e, failed: true } : e)))
      return
    }
    window.localStorage.setItem(match.slotKey, match.snapshot)
  } catch {
    /* ignore */
  }
  writePendingSaves(entries.filter((e) => e.tmpId !== tmpId))
}

/** Restore any failed-and-still-parked snapshots whose slot has since
 *  freed. Called from the slot read paths (Resume pill scan, strength
 *  peek) so a deferred restore surfaces as soon as the blocking newer
 *  session is itself saved or discarded. One entry per slot restores
 *  per call (oldest first); the rest wait for the next read. */
export function restoreFailedPendingSaves(): void {
  const entries = readPendingSaves(Date.now())
  if (!entries.some((e) => e.failed)) return
  const remaining: PendingSaveEntry[] = []
  const restoredSlots = new Set<string>()
  for (const e of entries) {
    if (!e.failed || restoredSlots.has(e.slotKey)) {
      remaining.push(e)
      continue
    }
    try {
      if (window.localStorage.getItem(e.slotKey) != null) {
        remaining.push(e)
        continue
      }
      window.localStorage.setItem(e.slotKey, e.snapshot)
      restoredSlots.add(e.slotKey)
    } catch {
      remaining.push(e)
    }
  }
  writePendingSaves(remaining)
}

/** Cheap unique live-session id (not stored server-side — only the
 *  saved workout payload carries it). Avoids pulling ulid into the
 *  web bundle. */
export function newLiveSessionId(): string {
  return `sl_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

/** Read the strength slot and return a session worth surfacing —
 *  running or done, within the 24h staleness window. A stale snapshot
 *  is cleared as a side effect (it's more likely a forgotten
 *  previous-user session than something to keep). This is THE
 *  staleness decision: the live page's hydration and the composer's
 *  "Start now" overwrite check both go through here so they can never
 *  disagree about which sessions still count. */
export function peekResumableStrengthSession(nowMs: number): StrengthSessionState | null {
  try {
    // Surface any failed-save snapshot whose slot has freed up first —
    // this read path is exactly when a deferred restore should land.
    restoreFailedPendingSaves()
    const raw = window.localStorage.getItem(STRENGTH_LS_KEY)
    if (!raw) return null
    const restored = restoreStrengthSession(raw)
    if (!restored) return null
    if (isLiveSessionStale(restored.startedAtMs, restored.finishedAtMs, nowMs)) {
      clearStrengthSession()
      return null
    }
    if (restored.phase === 'running' || restored.phase === 'done') return restored
    return null
  } catch {
    return null
  }
}

/** Write a session into the strength slot (the live page restores from
 *  it on mount). Returns false when storage is unavailable. */
export function writeStrengthSession(state: StrengthSessionState): boolean {
  try {
    window.localStorage.setItem(STRENGTH_LS_KEY, serializeStrengthSession(state))
    return true
  } catch {
    return false
  }
}

export function clearStrengthSession(): void {
  try {
    window.localStorage.removeItem(STRENGTH_LS_KEY)
  } catch {
    /* ignore */
  }
}
