// Bottom-sheet form for creating — or, with the `exercise` prop, editing —
// a custom exercise. Opened from the Library header's "+ Add exercise"
// button, from a custom row's pencil (edit mode), and from the composer's
// ExercisePicker "create" row (prefilled with the typed query). POST
// /exercises is find-or-create, so re-submitting an existing name is
// harmless and returns the existing row.

import { useEffect, useState } from 'react'
import { Banner, ConfirmDialog, Drawer } from '@rallypoint/ui'
import {
  DISCIPLINES,
  MOVEMENT_PATTERNS,
  METRIC_SHAPES,
} from '@rallypoint/fitness-shared'
import type {
  Discipline,
  MovementPattern,
  MetricShape,
  ExerciseDto,
  SubmissionDto,
} from '@rallypoint/fitness-shared'
import {
  ApiError,
  createExercise,
  deleteExercise,
  listMuscleGroups,
  listSubmissions,
  patchExercise,
  queueSubmitExercise,
  submitExercise,
} from '../lib/api.js'
import type { MuscleGroupDto } from '../lib/api.js'
import {
  buildMuscleIndex,
  buildMusclesPayloadV2,
  primaryGroupIdForMuscles,
  primaryMuscleIdForMuscles,
  secondaryGroupIdsForMuscles,
  secondaryMuscleIdsForMuscles,
} from '../lib/exercise-view.js'
import { latestSubmissionForExercise, submissionStatusChip } from '../lib/submissions.js'

const METRIC_SHAPE_LABELS: Record<MetricShape, string> = {
  load_reps: 'Weight × reps',
  distance_time: 'Distance + time',
  rounds_reps: 'Rounds / reps',
  duration: 'Duration only',
}

function titleCase(s: string): string {
  return s
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export interface AddExerciseSheetProps {
  initialName?: string
  /** When set, the sheet edits this custom exercise instead of creating. */
  exercise?: ExerciseDto
  onClose: () => void
  onCreated: (exercise: ExerciseDto) => void
  /** Called after a successful delete (edit mode only). */
  onDeleted?: (id: string) => void
}

export function AddExerciseSheet({
  initialName,
  exercise,
  onClose,
  onCreated,
  onDeleted,
}: AddExerciseSheetProps) {
  const editing = exercise ?? null
  const [name, setName] = useState(editing?.name ?? initialName ?? '')
  const [discipline, setDiscipline] = useState<Discipline>(editing?.discipline ?? 'bodyweight')
  const [pattern, setPattern] = useState<MovementPattern>(editing?.movementPattern ?? 'other')
  const [shape, setShape] = useState<MetricShape>(editing?.metricShape ?? 'load_reps')
  const [unilateral, setUnilateral] = useState(editing?.unilateral ?? false)
  // Create mode only: also submit the new exercise to the catalog review
  // queue. Default ON — most custom exercises are generally useful. The
  // server requires a primary muscle to submit, so the toggle disarms
  // (and the save skips the submit) until one is picked.
  const [submitToCatalog, setSubmitToCatalog] = useState(true)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [groups, setGroups] = useState<MuscleGroupDto[]>([])
  const [primaryGroupId, setPrimaryGroupId] = useState<string | null>(null)
  const [secondaryGroupIds, setSecondaryGroupIds] = useState<string[]>([])
  // Specific-muscle picks revealed under the selected groups. null / absent
  // falls back to the group's representative muscle, so the coarse
  // group-only flow keeps working unchanged.
  const [primaryMuscleId, setPrimaryMuscleId] = useState<string | null>(null)
  const [secondaryMuscleIds, setSecondaryMuscleIds] = useState<string[]>([])

  // Submission-to-catalog state (edit mode only — a brand-new exercise
  // has nothing to submit yet).
  const [submission, setSubmission] = useState<SubmissionDto | null>(null)
  const [confirmingSubmit, setConfirmingSubmit] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!editing) return
    let cancelled = false
    listSubmissions()
      .then((res) => {
        if (!cancelled) setSubmission(latestSubmissionForExercise(res.submissions, editing.id))
      })
      .catch(() => {
        // Non-fatal: the sheet just won't show a status chip / will let
        // the actor attempt to (re-)submit; the server still enforces
        // the "one pending submission" rule.
      })
    return () => {
      cancelled = true
    }
  }, [editing?.id])

  async function handleSubmitToCatalog() {
    if (!editing) return
    setError(null)
    setSubmitting(true)
    try {
      const created = await submitExercise(editing.id)
      setSubmission(created)
      setConfirmingSubmit(false)
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not submit that exercise for review.',
      )
      setConfirmingSubmit(false)
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    listMuscleGroups()
      .then((res) => {
        if (!cancelled) setGroups(res.groups)
      })
      .catch(() => {
        // Non-fatal: the picker just stays empty and the exercise saves
        // without a muscle map.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Prefill the picker once both the taxonomy and the editing exercise's
  // existing muscle map are available.
  useEffect(() => {
    if (!editing || groups.length === 0) return
    const index = buildMuscleIndex(groups)
    setPrimaryGroupId(primaryGroupIdForMuscles(editing.muscles, index))
    setSecondaryGroupIds(secondaryGroupIdsForMuscles(editing.muscles, index))
    setPrimaryMuscleId(primaryMuscleIdForMuscles(editing.muscles, index))
    setSecondaryMuscleIds(secondaryMuscleIdsForMuscles(editing.muscles, index))
    // Only re-run if the taxonomy or which exercise we're editing changes.
  }, [groups, editing?.id])

  function musclesOfGroup(groupId: string): string[] {
    return groups.find((g) => g.id === groupId)?.muscles.map((m) => m.id) ?? []
  }

  function togglePrimaryGroup(groupId: string) {
    setPrimaryGroupId((cur) => (cur === groupId ? null : groupId))
    // A group switch invalidates any specific pick from the old group.
    setPrimaryMuscleId(null)
    setSecondaryGroupIds((cur) => cur.filter((g) => g !== groupId))
    const groupMuscles = musclesOfGroup(groupId)
    setSecondaryMuscleIds((cur) => cur.filter((id) => !groupMuscles.includes(id)))
  }

  function toggleSecondaryGroup(groupId: string) {
    if (groupId === primaryGroupId) return
    const removing = secondaryGroupIds.includes(groupId)
    setSecondaryGroupIds((cur) => {
      if (cur.includes(groupId)) return cur.filter((g) => g !== groupId)
      if (cur.length >= 3) return cur
      return [...cur, groupId]
    })
    if (removing) {
      const groupMuscles = musclesOfGroup(groupId)
      setSecondaryMuscleIds((cur) => cur.filter((id) => !groupMuscles.includes(id)))
    }
  }

  function togglePrimaryMuscle(muscleId: string) {
    setPrimaryMuscleId((cur) => (cur === muscleId ? null : muscleId))
  }

  function toggleSecondaryMuscle(muscleId: string) {
    setSecondaryMuscleIds((cur) =>
      cur.includes(muscleId) ? cur.filter((id) => id !== muscleId) : [...cur, muscleId],
    )
  }

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give the exercise a name.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const muscles = buildMusclesPayloadV2({
        primaryGroupId,
        primaryMuscleId,
        secondaryGroupIds,
        secondaryMuscleIds,
        groups,
      })
      const exercise = editing
        ? await patchExercise(editing.id, {
            name: trimmed,
            discipline,
            movementPattern: pattern,
            metricShape: shape,
            unilateral,
            muscles,
          })
        : await createExercise({
            name: trimmed,
            discipline,
            movementPattern: pattern,
            metricShape: shape,
            unilateral,
            muscles,
          })
      if (!editing && submitToCatalog && primaryGroupId != null) {
        // Fire-and-forget via the outbox (sequences after the create,
        // tmp-id safe). A failed submit must not fail the create — the
        // exercise exists either way and can be resubmitted from edit.
        try {
          await queueSubmitExercise(exercise.id)
        } catch {
          // Non-fatal by design.
        }
      }
      onCreated(exercise)
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not create that exercise.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!editing) return
    setError(null)
    setSaving(true)
    try {
      await deleteExercise(editing.id)
      onDeleted?.(editing.id)
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not delete that exercise.',
      )
      setConfirmingDelete(false)
    } finally {
      setSaving(false)
    }
  }

  const fieldLabel = { fontSize: 11, color: 'var(--ink-dim)', fontWeight: 500 } as const

  return (
    <Drawer open mobileSheet title={editing ? 'Edit exercise' : 'Add exercise'} onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}

        {editing &&
          (() => {
            const chip = submissionStatusChip(submission)
            if (!chip) return null
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="pl-chip sm">
                  {chip.label.toUpperCase()}
                </span>
                {chip.tone === 'rejected' && submission?.adminNote && (
                  <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{submission.adminNote}</span>
                )}
              </div>
            )
          })()}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={fieldLabel}>Name</span>
          <input
            className="pl-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sandbag carry"
            maxLength={120}
            autoFocus
          />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>Discipline</span>
            <select
              className="pl-input"
              value={discipline}
              onChange={(e) => setDiscipline(e.target.value as Discipline)}
            >
              {DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {titleCase(d)}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>Movement pattern</span>
            <select
              className="pl-input"
              value={pattern}
              onChange={(e) => setPattern(e.target.value as MovementPattern)}
            >
              {MOVEMENT_PATTERNS.map((p) => (
                <option key={p} value={p}>
                  {titleCase(p)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={fieldLabel}>How results are logged</span>
          <select
            className="pl-input"
            value={shape}
            onChange={(e) => setShape(e.target.value as MetricShape)}
          >
            {METRIC_SHAPES.map((s) => (
              <option key={s} value={s}>
                {METRIC_SHAPE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={unilateral}
            onChange={(e) => setUnilateral(e.target.checked)}
          />
          <span style={{ fontSize: 13 }}>Unilateral (one side at a time)</span>
        </label>

        {groups.length > 0 && (
          <>
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={fieldLabel}>Primary muscle group</span>
              <div className="day-chips" role="radiogroup" aria-label="Primary muscle group">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    role="radio"
                    aria-checked={primaryGroupId === g.id}
                    className={`day-chip${primaryGroupId === g.id ? ' on' : ''}`}
                    onClick={() => togglePrimaryGroup(g.id)}
                  >
                    {g.name}
                  </button>
                ))}
              </div>
              {primaryGroupId &&
                (() => {
                  const group = groups.find((g) => g.id === primaryGroupId)
                  if (!group || group.muscles.length <= 1) return null
                  return (
                    <div className="day-chips" role="radiogroup" aria-label="Primary muscle">
                      {group.muscles.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          role="radio"
                          aria-checked={primaryMuscleId === m.id}
                          className={`day-chip sm${primaryMuscleId === m.id ? ' on' : ''}`}
                          onClick={() => togglePrimaryMuscle(m.id)}
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                  )
                })()}
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <span style={fieldLabel}>Also works (optional, up to 3)</span>
              <div className="day-chips" aria-label="Secondary muscle groups">
                {groups.map((g) => {
                  const selected = secondaryGroupIds.includes(g.id)
                  const disabled =
                    g.id === primaryGroupId || (!selected && secondaryGroupIds.length >= 3)
                  return (
                    <button
                      key={g.id}
                      type="button"
                      aria-pressed={selected}
                      className={`day-chip${selected ? ' on' : ''}`}
                      onClick={() => toggleSecondaryGroup(g.id)}
                      disabled={disabled}
                      style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                    >
                      {g.name}
                    </button>
                  )
                })}
              </div>
              {secondaryGroupIds.map((groupId) => {
                const group = groups.find((g) => g.id === groupId)
                if (!group || group.muscles.length <= 1) return null
                return (
                  <div
                    key={groupId}
                    className="day-chips"
                    aria-label={`${group.name} muscles`}
                  >
                    {group.muscles.map((m) => {
                      const selected = secondaryMuscleIds.includes(m.id)
                      return (
                        <button
                          key={m.id}
                          type="button"
                          aria-pressed={selected}
                          className={`day-chip sm${selected ? ' on' : ''}`}
                          onClick={() => toggleSecondaryMuscle(m.id)}
                        >
                          {m.name}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {!editing && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={submitToCatalog && primaryGroupId != null}
              disabled={primaryGroupId == null}
              onChange={(e) => setSubmitToCatalog(e.target.checked)}
            />
            <span
              style={{
                fontSize: 13,
                ...(primaryGroupId == null ? { color: 'var(--ink-dim)' } : {}),
              }}
            >
              Submit to catalog for review
              {primaryGroupId == null && ' — pick a primary muscle group first'}
            </span>
          </label>
        )}

        {editing && (!submission || submission.status === 'rejected') && (
          <button
            type="button"
            className="fit-startbtn ghost"
            onClick={() => setConfirmingSubmit(true)}
            disabled={saving || submitting}
          >
            {submission?.status === 'rejected' ? 'Resubmit to catalog' : 'Submit to catalog'}
          </button>
        )}

        <div className="btn-row">
          <button type="button" className="fit-startbtn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {editing && (
            <button
              type="button"
              className="fit-startbtn ghost hot"
              onClick={() => setConfirmingDelete(true)}
              disabled={saving}
            >
              Delete
            </button>
          )}
          <button type="button" className="fit-startbtn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add exercise'}
          </button>
        </div>
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          open
          title="Delete this exercise?"
          body="It will be removed from your catalog. Exercises with logged history can't be deleted."
          confirmLabel="Delete"
          confirmVariant="hot"
          busy={saving}
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {confirmingSubmit && (
        <ConfirmDialog
          open
          title="Submit for catalog review?"
          body="An admin will review this exercise. If accepted, it becomes a built-in exercise available to everyone — you'll be offered the chance to migrate your logged history to it."
          confirmLabel="Submit"
          busy={submitting}
          onConfirm={handleSubmitToCatalog}
          onCancel={() => setConfirmingSubmit(false)}
        />
      )}
    </Drawer>
  )
}
