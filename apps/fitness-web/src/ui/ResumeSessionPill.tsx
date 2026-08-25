// Resume pill — when a live session is persisted, render a floating
// glass pill (the kit's `.rp-subbar`, positioned via `.fit-resume-pill`
// in fitness.css — kit slot above the tab bar, lifted one slot higher
// when the page floats its own docked SubBar so it never covers the
// section switcher) that bounces back into the session on tap; the
// accent dot, label and countdown carry the state. Scans both the WOD and strength
// localStorage keys (the two live engines persist independently) and
// picks the most recently started session.
//
// Surfaces TWO states:
//   - running: tap to RESUME the session (running clock shown).
//   - done: tap to FINISH SAVING the session (the engine left the
//     result in localStorage but the user never saved or discarded).
//     Without this, a done-but-unsaved session lives in localStorage
//     invisible to the user — they'd never realize their score was
//     still recoverable (code-review F5).

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatMmss, isLiveSessionStale, pausedAwareElapsedMs } from '@rallypoint/fitness-shared'
import {
  REP_LS_KEY,
  restoreFailedPendingSaves,
  STRENGTH_LS_KEY,
  WOD_LS_KEY,
} from '../lib/live-session-keys.js'

interface PersistedSessionBase {
  sessionId: string
  templateName?: string
  startedAtMs?: number | null
  finishedAtMs?: number | null
  phase?: string
  /** Strength sessions persist pause state; the clock must freeze on it
   *  (same formula as the reducer's TICK via pausedAwareElapsedMs). */
  pausedAtMs?: number | null
  pausedTotalMs?: number
}

interface PersistedWodSession extends PersistedSessionBase {
  kind: 'wod'
  templateId: string | null
}

interface PersistedStrengthSession extends PersistedSessionBase {
  kind: 'strength'
}

// Rep-entry sessions link back to a WOD template; surface them as a
// 'wod'-kind entry so the pill navigates to the same template route.
interface PersistedRepSession extends PersistedSessionBase {
  kind: 'rep'
  templateId: string | null
}

type PersistedSession = PersistedWodSession | PersistedStrengthSession | PersistedRepSession

function readPersisted(): PersistedSession | null {
  // A failed workout save parked while its slot was reoccupied restores
  // lazily once the slot frees — run that sweep before scanning.
  restoreFailedPendingSaves()
  let wod: PersistedWodSession | null = null
  let strength: PersistedStrengthSession | null = null
  let rep: PersistedRepSession | null = null
  try {
    const rawW = localStorage.getItem(WOD_LS_KEY)
    if (rawW) {
      const parsed = JSON.parse(rawW) as { templateId?: string | null } & PersistedSessionBase
      wod = { ...parsed, kind: 'wod', templateId: parsed.templateId ?? null }
    }
  } catch {
    /* ignore */
  }
  try {
    const rawS = localStorage.getItem(STRENGTH_LS_KEY)
    if (rawS) {
      const parsed = JSON.parse(rawS) as PersistedSessionBase
      strength = { ...parsed, kind: 'strength' }
    }
  } catch {
    /* ignore */
  }
  try {
    const rawR = localStorage.getItem(REP_LS_KEY)
    if (rawR) {
      const parsed = JSON.parse(rawR) as { templateId?: string | null } & PersistedSessionBase
      rep = { ...parsed, kind: 'rep', templateId: parsed.templateId ?? null }
    }
  } catch {
    /* ignore */
  }

  // Surface both running and done sessions. 'pre' states are dropped
  // (nothing to resume yet — the user is still picking exercises).
  // Hard staleness drop: past 24h a persisted session is more likely
  // a forgotten previous-user state than something we should surface
  // (code-review F15). Same threshold both engines apply on restore.
  const nowMs = Date.now()
  const eligible = [wod, strength, rep].filter((s): s is PersistedSession => {
    if (!s) return false
    if (s.phase !== 'running' && s.phase !== 'done') return false
    if (s.phase === 'running' && s.startedAtMs == null) return false
    if (isLiveSessionStale(s.startedAtMs ?? null, s.finishedAtMs ?? null, nowMs)) {
      return false
    }
    return true
  })
  if (eligible.length === 0) return null
  // If both happen to exist, prefer the most recently started.
  eligible.sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0))
  return eligible[0]!
}

export function ResumeSessionPill() {
  const [session, setSession] = useState<PersistedSession | null>(() => readPersisted())
  // `_now` is a write-only ticker: we never read its value, only bump
  // it once per second to force a re-render so the running clock at
  // the bottom of the pill stays in sync without re-deriving session
  // state. The underscore prefix marks it intentionally unused.
  const [, setNowTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => {
      // Re-poll storage so the pill drops as soon as the user finishes /
      // discards the session in another tab.
      setSession(readPersisted())
      setNowTick((n) => n + 1)
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  const target = useMemo(() => {
    if (!session) return null
    // Rep-entry sessions run inside WodSessionPage at the same template
    // route as WOD sessions (the page picks the engine), so they resume there.
    if (session.kind === 'wod' || session.kind === 'rep') {
      if (!session.templateId) return null
      return `/live/wod/${encodeURIComponent(session.templateId)}/run`
    }
    // Strength sessions live at the singular new-session route;
    // hydration happens via the localStorage read on mount.
    return '/live/strength/new'
  }, [session])

  if (!target || !session) return null
  const isDone = session.phase === 'done'
  // Running sessions show the live clock; done sessions show the
  // frozen finished elapsed (or nothing if both anchors are missing).
  const anchor = isDone ? session.finishedAtMs ?? session.startedAtMs : session.startedAtMs
  if (anchor == null) return null
  // Running clock is paused-aware: frozen at pausedAtMs with prior
  // pauses excluded, matching the live engine's elapsedS exactly.
  const isPaused = !isDone && session.pausedAtMs != null
  // Done sessions exclude paused time too (FINISH folds any open pause
  // into pausedTotalMs, so subtracting it matches the engine's final
  // elapsedS instead of raw wall-clock span).
  const elapsedMs = isDone
    ? anchor - (session.startedAtMs ?? anchor) - (session.pausedTotalMs ?? 0)
    : pausedAwareElapsedMs(
        anchor,
        session.pausedAtMs ?? null,
        session.pausedTotalMs ?? 0,
        Date.now(),
      )
  // Hot tint for done so it visually reads differently from running.
  const accent = isDone ? 'var(--hot)' : 'var(--acid)'
  const label = isDone ? 'FINISH SAVING' : isPaused ? 'PAUSED' : 'RESUME'
  return (
    <Link to={target} className="rp-subbar fit-resume-pill">
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: accent,
          flex: 'none',
        }}
      />
      <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>
        {session.templateName ?? (session.kind === 'strength' ? 'Strength session' : 'Session')}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: accent }}>
        {formatMmss(elapsedMs / 1000)}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: accent,
        }}
      >
        {label}
      </span>
    </Link>
  )
}
