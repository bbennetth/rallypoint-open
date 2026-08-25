// Bottom-sheet history for a single exercise, opened from the live
// strength-logging screen's inline "LAST · …" hint. Shows the most recent
// sessions' working sets ("how much did I do last time") so the athlete
// can pick a load without leaving the workout. Read-only; same Drawer +
// fit-card styling as the other session sheets.

import { useEffect, useState } from 'react'
import { Banner, Drawer } from '@rallypoint/ui'
import type { ExerciseHistorySession } from '@rallypoint/fitness-shared'
import type { WeightUnit } from '../lib/units.js'
import { ApiError, getExerciseHistory } from '../lib/api.js'
import { formatHistorySet, formatSessionDate } from '../lib/exercise-history-view.js'

export interface ExerciseHistorySheetProps {
  exerciseId: string
  exerciseName: string
  unit: WeightUnit
  /** Sessions the caller already loaded (the live screen's inline hint
   *  fetches these) — shown instantly, skipping a duplicate round-trip.
   *  Explicit `| undefined` so callers can pass a possibly-absent cache
   *  entry directly under exactOptionalPropertyTypes. */
  initialSessions?: ExerciseHistorySession[] | undefined
  onClose: () => void
}

export function ExerciseHistorySheet({
  exerciseId,
  exerciseName,
  unit,
  initialSessions,
  onClose,
}: ExerciseHistorySheetProps) {
  const [sessions, setSessions] = useState<ExerciseHistorySession[] | null>(
    initialSessions ?? null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Already have the data from the caller's cache — render it, no fetch.
    if (initialSessions) return
    let cancelled = false
    setSessions(null)
    setError(null)
    getExerciseHistory(exerciseId, 8)
      .then((res) => {
        if (!cancelled) setSessions(res.sessions)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // A never-logged exercise 404s — that's an empty history, not an
        // error the user needs to see.
        if (err instanceof ApiError && err.status === 404) {
          setSessions([])
          return
        }
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Could not load history.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [exerciseId, initialSessions])

  return (
    <Drawer open mobileSheet title={`History — ${exerciseName}`} onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        {error && <Banner tone="error">{error}</Banner>}

        {sessions == null && !error && (
          <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>Loading…</div>
        )}

        {sessions != null && sessions.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--ink-dim)', padding: '8px 0' }}>
            No history yet — this is your first time logging {exerciseName}.
          </div>
        )}

        {sessions?.map((s) => (
          <div key={s.workoutId} className="ex-hist-session">
            <div className="ex-hist-date">
              {formatSessionDate(s.performedAt)}
              {s.workoutTitle ? <span className="ex-hist-ttl"> · {s.workoutTitle}</span> : null}
            </div>
            <div className="ex-hist-sets">
              {s.sets.map((set, i) => (
                <span key={i} className="ex-hist-set">
                  {formatHistorySet(set, unit)}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Drawer>
  )
}
