// Grouped-by-date workout history per the Ink design handoff: a single
// page head, sessions bucketed under date labels (Today / Yesterday /
// Mon 23 Jun), each session rendered as a `.wkrow` row. Tap → opens
// WorkoutDetailSheet (read-only; Edit navigates to the composer, Delete
// uses ConfirmDialog).

import { useMemo, useState } from 'react'
import { Banner, ConfirmDialog, EmptyState } from '@rallypoint/ui'
import { deleteWorkout, workoutsQuery, exercisesQuery, ApiError } from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { groupWorkoutsByDate, isoToLocalDate } from '../lib/workout-view.js'
import { HistoryRow } from './HistoryRow.js'
import { WorkoutDetailSheet } from './WorkoutDetailSheet.js'

function todayLocalDate(): string {
  return isoToLocalDate(new Date().toISOString())
}

function errMessage(err: unknown, fallback = 'Failed to load history.'): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : fallback
}

export function HistoryView() {
  const [openWorkoutId, setOpenWorkoutId] = useState<string | null>(null)
  // Row staged for deletion from the swipe/hover tray. The sheet keeps
  // its own confirm-then-delete path; this one covers the row shortcut.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const today = todayLocalDate()

  // Render-from-cache: both reads paint the last-known value instantly
  // and re-render on every cache write — including the delete below
  // (WorkoutDetailSheet's onDeleted callback), so no manual
  // setWorkouts mirroring is needed.
  const workoutsQ = useCachedQuery(useMemo(() => workoutsQuery(), []))
  const exercisesQ = useCachedQuery(useMemo(() => exercisesQuery(), []))
  const workouts = workoutsQ.data ?? []
  const loading = workoutsQ.status === 'loading' || exercisesQ.status === 'loading'
  const error =
    workoutsQ.status === 'error'
      ? errMessage(workoutsQ.error)
      : exercisesQ.status === 'error'
        ? errMessage(exercisesQ.error)
        : null

  const exerciseNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const ex of exercisesQ.data ?? []) names.set(ex.id, ex.name)
    return names
  }, [exercisesQ.data])

  const grouped = useMemo(() => groupWorkoutsByDate(workouts, today), [workouts, today])
  const openWorkout = useMemo(
    () => (openWorkoutId ? workouts.find((w) => w.id === openWorkoutId) ?? null : null),
    [openWorkoutId, workouts],
  )

  // deleteWorkout (called from WorkoutDetailSheet) is local-first — the
  // workouts cache is already patched and subscribers notified by the
  // time onDeleted fires. Close the sheet; no manual setWorkouts needed.
  const handleDeleted = (_id: string) => {
    setOpenWorkoutId(null)
  }

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="top">
          <div>
            <div className="eyebrow">ALL SESSIONS</div>
            <h1>History</h1>
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--ink-mute)',
              textTransform: 'uppercase',
            }}
          >
            {workouts.length} total
          </div>
        </div>
      </header>

      {error && <Banner tone="error">{error}</Banner>}
      {deleteError && <Banner tone="error">{deleteError}</Banner>}

      {loading ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : grouped.length === 0 ? (
        <EmptyState
          title="No workouts logged yet"
          body="Start a WOD from the Library or pick a session from the Today tab to begin."
        />
      ) : (
        <div style={{ display: 'grid', gap: 20 }}>
          {grouped.map((bucket) => (
            <section key={bucket.date} style={{ display: 'grid', gap: 8 }}>
              <div className="sec-rule" style={{ margin: 0 }}>
                <div className="eyebrow">{bucket.label}</div>
                <div className="line" />
                <span className="ct">{bucket.workouts.length}</span>
              </div>
              <ul className="wk-list">
                {bucket.workouts.map((w) => (
                  <HistoryRow
                    key={w.id}
                    workout={w}
                    onClick={() => setOpenWorkoutId(w.id)}
                    onDelete={() => setConfirmDeleteId(w.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete this workout?"
        body="The session and all its sets will be removed. This can't be undone."
        confirmLabel="Delete"
        confirmVariant="hot"
        onConfirm={async () => {
          const id = confirmDeleteId
          setConfirmDeleteId(null)
          if (!id) return
          try {
            setDeleteError(null)
            // deleteWorkout is local-first — the workouts cache is
            // patched and subscribers re-rendered before this resolves,
            // so no manual state filtering is needed here either.
            await deleteWorkout(id)
          } catch (err: unknown) {
            setDeleteError(errMessage(err, 'Failed to delete the workout.'))
          }
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />

      {openWorkout && (
        <WorkoutDetailSheet
          workout={openWorkout}
          exerciseNames={exerciseNames}
          onClose={() => setOpenWorkoutId(null)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
