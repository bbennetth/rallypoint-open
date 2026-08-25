// Read-only detail sheet for a logged workout. Per the design handoff:
// chips (modality / type / time / tonnage / RPE / PR), the movement
// list, and Repeat / Edit ghost buttons at the bottom. Edit navigates
// to the Composer (S8) — until then the route renders the composer
// placeholder. Delete uses ConfirmDialog. Built on the shared
// `<Drawer mobileSheet>` so it slides up from the bottom on phones.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConfirmDialog, Drawer } from '@rallypoint/ui'
import type { Modality } from '@rallypoint/fitness-shared'
import { MODALITIES, summarizeWorkoutSets, weatherFromPayload } from '@rallypoint/fitness-shared'
import type { WorkoutDto } from '../lib/api.js'
import { deleteWorkout, getWodTemplate, ApiError } from '../lib/api.js'
import {
  formatWorkoutSummaryLine,
  groupSetsByExercise,
  modalityLabel,
} from '../lib/workout-view.js'
import {
  buildStrengthTemplateBody,
  hasUsableStrengthSets,
} from '../lib/strength-template-build.js'
import { SaveAsTemplateDialog } from './SaveAsTemplateDialog.js'
import { readWodPayload, wodPayloadTypeLabel } from '../lib/wod-payload.js'
import { formatDistanceM, formatTonnage, useWeightUnit } from '../lib/units.js'

function isKnownModality(m: string): m is Modality {
  return (MODALITIES as readonly string[]).includes(m)
}

function fmtSeconds(s: number): string {
  if (s <= 0) return ''
  const total = Math.round(s)
  const m = Math.floor(total / 60)
  const sec = total % 60
  if (m === 0) return `${sec}s`
  return `${m}m${sec ? ` ${sec}s` : ''}`
}

export interface WorkoutDetailSheetProps {
  workout: WorkoutDto
  /** exerciseId → display name. The parent owns the catalog fetch. */
  exerciseNames: Map<string, string>
  onClose: () => void
  /** Called after a successful delete so the parent can rerender. */
  onDeleted: (id: string) => void
}

export function WorkoutDetailSheet({
  workout,
  exerciseNames,
  onClose,
  onDeleted,
}: WorkoutDetailSheetProps) {
  const nav = useNavigate()
  const unit = useWeightUnit()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const summary = summarizeWorkoutSets(workout.sets)
  const wod = readWodPayload(workout)
  const isWod = wod !== null
  const chips: string[] = []
  if (isKnownModality(workout.modality)) chips.push(modalityLabel(workout.modality))
  if (isWod && wod) {
    chips.push(wodPayloadTypeLabel(wod))
    if (wod.dnf) chips.push('DNF')
  }
  if (workout.durationS && workout.durationS > 0) chips.push(fmtSeconds(workout.durationS))
  // stored kg -> display unit; storage stays kg
  if (summary.tonnageKg > 0) chips.push(formatTonnage(summary.tonnageKg, unit))
  if (workout.rpe != null) chips.push(`RPE ${workout.rpe}`)
  // Running weather snapshot (payload.weather) — stamped at save time
  // from the shared Open-Meteo pipeline; absent on most workouts.
  const weather = weatherFromPayload(workout.payload)
  if (weather) {
    chips.push(
      `${Math.round(weather.temperatureC)}°C${
        weather.windSpeedKmh != null ? ` · ${Math.round(weather.windSpeedKmh)} km/h wind` : ''
      }`,
    )
  }

  const sumLine = formatWorkoutSummaryLine(summary)
  const setGroups = groupSetsByExercise(workout.sets, exerciseNames)

  // Source-template link for the update-template flow. Strength
  // workouts started from a custom template stamp payload.templateId
  // (workout-payload.ts); resolve it to confirm the template still
  // exists and is a user-owned custom strength row. A 404 (deleted
  // since) or a non-custom/benchmark row quietly degrades to the
  // create-only save flow.
  const strengthTemplateId =
    workout.modality === 'strength' && typeof workout.payload?.templateId === 'string'
      ? workout.payload.templateId
      : null
  const [updateTarget, setUpdateTarget] = useState<{ id: string; name: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    setUpdateTarget(null)
    if (!strengthTemplateId) return
    getWodTemplate(strengthTemplateId)
      .then((tpl) => {
        if (cancelled) return
        if (tpl.kind === 'strength' && tpl.isCustom && !tpl.isBenchmark) {
          setUpdateTarget({ id: tpl.id, name: tpl.name })
        }
      })
      .catch(() => {
        // Missing/inaccessible template — the update option just
        // doesn't appear.
      })
    return () => {
      cancelled = true
    }
  }, [strengthTemplateId])

  async function handleDelete() {
    setError(null)
    setDeleting(true)
    try {
      await deleteWorkout(workout.id)
      onDeleted(workout.id)
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not delete that workout.',
      )
      setConfirmingDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Drawer
        open
        mobileSheet
        title={wod?.templateName ?? workout.title ?? modalityLabel(workout.modality)}
        onClose={onClose}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {chips.map((c, i) => (
              <span key={i} className="pl-chip">
                {c}
              </span>
            ))}
          </div>

          {sumLine && !isWod && (
            <div className="hist-sets">{sumLine}</div>
          )}

          {setGroups.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }}>
              <div className="sec-rule" style={{ margin: 0 }}>
                <div className="eyebrow">Movements</div>
                <div className="line" />
              </div>
              <ol style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 6 }}>
                {setGroups.map((g) => {
                  const totalReps = g.sets.reduce((a, s) => a + (s.reps ?? 0), 0)
                  const totalCal = g.sets.reduce((a, s) => a + (s.calories ?? 0), 0)
                  const totalDistM = g.sets.reduce((a, s) => a + (s.distanceM ?? 0), 0)
                  const inclines = g.sets
                    .map((s) => s.inclinePct)
                    .filter((v): v is number => v != null && v > 0)
                  const maxIncline = inclines.length ? Math.max(...inclines) : null
                  return (
                    <li key={g.exerciseId} style={{ fontSize: 14, color: 'var(--ink)' }}>
                      {g.exerciseName}
                      {g.sets.length > 1 && (
                        <span style={{ color: 'var(--ink-dim)' }}> · {g.sets.length} sets</span>
                      )}
                      {totalReps > 0 && (
                        <span style={{ color: 'var(--ink-dim)' }}> · {totalReps} reps</span>
                      )}
                      {totalCal > 0 && (
                        <span style={{ color: 'var(--ink-dim)' }}> · {totalCal} cal</span>
                      )}
                      {totalDistM > 0 && (
                        <span style={{ color: 'var(--ink-dim)' }}>
                          {' '}
                          · {formatDistanceM(totalDistM)}
                        </span>
                      )}
                      {maxIncline != null && (
                        <span style={{ color: 'var(--ink-dim)' }}> · {maxIncline}% incline</span>
                      )}
                    </li>
                  )
                })}
              </ol>
            </div>
          )}

          {workout.notes && <p className="wod-note">{workout.notes}</p>}

          {error && <div style={{ color: 'var(--hot)', fontSize: 13 }}>{error}</div>}

          <div className="btn-row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
            {/* Edit navigates to the template in the composer. Only WOD
                workouts store a templateId in their payload (strength logs
                do not, so the button is suppressed for them). */}
            {typeof workout.payload?.templateId === 'string' && (
              <button
                type="button"
                className="fit-startbtn ghost"
                onClick={() =>
                  nav(`/composer/${encodeURIComponent(workout.payload!.templateId as string)}`)
                }
              >
                Edit
              </button>
            )}
            {/* Save-as-template is only useful when the workout has a
                clearly reconstructible body — strength sessions
                (modality='strength') with at least one REP-BEARING set
                qualify. Pure duration-only sessions silently produced
                a `reps=1` template before S7 (code-review F11); now
                the button gates on the same rule the build path uses. */}
            {workout.modality === 'strength' && hasUsableStrengthSets(setGroups) && (
              <button
                type="button"
                className="fit-startbtn ghost"
                onClick={() => setSaveTemplateOpen(true)}
              >
                Save as template
              </button>
            )}
            <button
              type="button"
              className="fit-startbtn ghost hot"
              onClick={() => setConfirmingDelete(true)}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </Drawer>

      {/* Reconstruct a strength template body from the workout's grouped
          sets. Drops nullable fields the template schema disallows. */}
      <SaveAsTemplateDialog
        open={saveTemplateOpen}
        defaultName={updateTarget?.name ?? workout.title ?? ''}
        summary={
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--ink-dim)',
            }}
          >
            {setGroups.length} block{setGroups.length === 1 ? '' : 's'} ·{' '}
            {setGroups.reduce((a, g) => a + g.sets.length, 0)} sets
          </div>
        }
        build={(name) => ({
          name,
          body: buildStrengthTemplateBody(setGroups),
        })}
        updateTarget={updateTarget}
        buildPatch={() => ({ body: buildStrengthTemplateBody(setGroups) })}
        onClose={() => setSaveTemplateOpen(false)}
      />

      {confirmingDelete && (
        <ConfirmDialog
          open
          title="Delete this workout?"
          body="The session and all its sets will be removed. This can't be undone."
          confirmLabel="Delete"
          confirmVariant="hot"
          busy={deleting}
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </>
  )
}
