// Full-screen lightbox for a progress-picture SET: pose chips switch
// between the set's angles, the image fills the sheet, and edit (PATCH)
// / delete act on the currently shown photo. Deleting the last photo
// closes the drawer. mobileFull so the photo gets the whole dvh
// viewport on phones.

import { useState } from 'react'
import { Banner, ConfirmDialog, Drawer } from '@rallypoint/ui'
import { KNOWN_POSES, poseLabel, poseSchema } from '@rallypoint/fitness-shared'
import type { ProgressPhotoDto } from '../lib/api.js'
import {
  ApiError,
  deleteProgressPhoto,
  metricsQuery,
  patchProgressPhoto,
  progressPhotoImageUrl,
} from '../lib/api.js'
import { datetimeLocalToIso, formatValue, isoToDatetimeLocal, nearestMetricTo } from '../lib/metric-view.js'
import { kgToDisplay, useWeightUnit } from '../lib/units.js'
import {
  progressExportFileName,
  renderProgressExport,
  shareOrDownload,
} from '../lib/progress-export.js'

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback
}

function takenAtDisplay(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export interface ProgressPhotoDetailProps {
  // The set's photos in display order (a singleton array for legacy /
  // single-angle entries).
  photos: ProgressPhotoDto[]
  // Which photo to open on (defaults to the first).
  initialPhotoId?: string
  // Extra pose chips for the edit form (the user's custom slugs).
  customPoses: string[]
  onClose: () => void
  onChanged: (photo: ProgressPhotoDto) => void
  onDeleted: (id: string) => void
}

export function ProgressPhotoDetail({
  photos: initialPhotos,
  initialPhotoId,
  customPoses,
  onClose,
  onChanged,
  onDeleted,
}: ProgressPhotoDetailProps) {
  // Local copy so edits/deletes reflect immediately while the parent
  // refetches in the background.
  const [photos, setPhotos] = useState(initialPhotos)
  const [currentId, setCurrentId] = useState(
    initialPhotoId && initialPhotos.some((p) => p.id === initialPhotoId)
      ? initialPhotoId
      : initialPhotos[0]!.id,
  )
  const photo = photos.find((p) => p.id === currentId) ?? photos[0]!

  const [editing, setEditing] = useState(false)
  const [pose, setPose] = useState(photo.pose)
  const [customPoseText, setCustomPoseText] = useState('')
  const [takenAt, setTakenAt] = useState(isoToDatetimeLocal(photo.takenAt))
  const [note, setNote] = useState(photo.note ?? '')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const weightUnit = useWeightUnit()

  function switchTo(id: string) {
    const next = photos.find((p) => p.id === id)
    if (!next) return
    setCurrentId(id)
    setEditing(false)
    setError(null)
    setPose(next.pose)
    setCustomPoseText('')
    setTakenAt(isoToDatetimeLocal(next.takenAt))
    setNote(next.note ?? '')
  }

  const poseChips = [
    ...KNOWN_POSES.map((p) => p.id),
    ...customPoses.filter((p) => !KNOWN_POSES.some((k) => k.id === p)),
    ...(customPoses.includes(photo.pose) || KNOWN_POSES.some((k) => k.id === photo.pose)
      ? []
      : [photo.pose]),
  ]

  async function handleSave() {
    const nextPose = customPoseText
      ? customPoseText.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '')
      : pose
    if (!poseSchema.safeParse(nextPose).success) {
      setError('Pose must contain at least one letter or digit.')
      return
    }
    if (!takenAt) {
      setError('Pick a date and time.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const trimmedNote = note.trim()
      const updated = await patchProgressPhoto(photo.id, {
        pose: nextPose,
        takenAt: datetimeLocalToIso(takenAt),
        note: trimmedNote || null,
      })
      setPhotos((cur) => cur.map((p) => (p.id === updated.id ? updated : p)))
      onChanged(updated)
      setEditing(false)
    } catch (err: unknown) {
      setError(errMessage(err, 'Could not save those changes.'))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    setBusy(true)
    try {
      await deleteProgressPhoto(photo.id)
      onDeleted(photo.id)
      const remaining = photos.filter((p) => p.id !== photo.id)
      if (remaining.length === 0) {
        onClose()
        return
      }
      setPhotos(remaining)
      setConfirmingDelete(false)
      setBusy(false)
      switchTo(remaining[0]!.id)
    } catch (err: unknown) {
      setConfirmingDelete(false)
      setError(errMessage(err, 'Could not delete that photo.'))
      setBusy(false)
    }
  }

  async function handleShare() {
    setError(null)
    setSharing(true)
    try {
      // Reuse the app's standard bodyweight metrics query/key (same one
      // BodyView/LogPage warm) rather than a bespoke {kind,limit} filter,
      // so this doesn't create a second, out-of-sync cache entry.
      const allMetrics = await metricsQuery().fetch()
      const metrics = allMetrics.filter((m) => m.kind === 'bodyweight')
      const nearestKg = nearestMetricTo(photo.takenAt, metrics)?.value ?? null
      const weightText = nearestKg == null ? null : formatValue(kgToDisplay(nearestKg, weightUnit, 1), weightUnit)
      const blob = await renderProgressExport([
        {
          url: progressPhotoImageUrl(photo.id),
          dateText: takenAtDisplay(photo.takenAt),
          weightText,
        },
      ])
      const result = await shareOrDownload(blob, progressExportFileName([photo]))
      if (result === 'cancelled') return
    } catch (err) {
      setError(errMessage(err, 'Could not share that photo.'))
    } finally {
      setSharing(false)
    }
  }

  const labelStyle = {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--ink-mute)',
  } as const

  return (
    <Drawer open mobileSheet mobileFull title={poseLabel(photo.pose)} onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}

        {photos.length > 1 && (
          <div className="day-chips" role="tablist" aria-label="Angle">
            {photos.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === photo.id}
                className={`day-chip${p.id === photo.id ? ' on' : ''}`}
                // Locked while busy, and while editing so a tap can't
                // silently discard the in-progress edit form.
                disabled={busy || (editing && p.id !== photo.id)}
                onClick={() => switchTo(p.id)}
              >
                {poseLabel(p.pose)}
              </button>
            ))}
          </div>
        )}

        <img
          src={progressPhotoImageUrl(photo.id)}
          alt={`Progress picture — ${poseLabel(photo.pose)}, ${takenAtDisplay(photo.takenAt)}`}
          className="pp-detail-img"
        />

        {!editing ? (
          <>
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={labelStyle}>{takenAtDisplay(photo.takenAt)}</div>
              {photo.note && (
                <div style={{ fontSize: 14, color: 'var(--ink-dim)' }}>{photo.note}</div>
              )}
            </div>
            <div className="btn-row">
              <button
                type="button"
                className="fit-startbtn ghost"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy}
              >
                Delete
              </button>
              <button
                type="button"
                className="fit-startbtn ghost"
                onClick={() => void handleShare()}
                disabled={busy || sharing}
              >
                {sharing ? 'Preparing…' : 'Share'}
              </button>
              <button
                type="button"
                className="fit-startbtn"
                onClick={() => setEditing(true)}
                disabled={busy}
              >
                Edit
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={labelStyle}>Pose</span>
              <div className="day-chips" role="radiogroup" aria-label="Pose">
                {poseChips.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={pose === p && !customPoseText}
                    className={`day-chip${pose === p && !customPoseText ? ' on' : ''}`}
                    onClick={() => {
                      setPose(p)
                      setCustomPoseText('')
                    }}
                  >
                    {poseLabel(p)}
                  </button>
                ))}
              </div>
              <input
                className="pl-input"
                placeholder="or a new pose, e.g. side flexed"
                maxLength={40}
                value={customPoseText}
                onChange={(e) => setCustomPoseText(e.target.value)}
              />
            </div>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={labelStyle}>Taken at</span>
              <input
                className="pl-input"
                type="datetime-local"
                value={takenAt}
                onChange={(e) => setTakenAt(e.target.value)}
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={labelStyle}>Note (optional)</span>
              <input
                className="pl-input"
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            <div className="btn-row">
              <button
                type="button"
                className="fit-startbtn ghost"
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="button" className="fit-startbtn" onClick={handleSave} disabled={busy}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </>
        )}
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          open
          title={`Delete the ${poseLabel(photo.pose)} photo?`}
          body="The picture is removed permanently — there is no undo."
          confirmLabel="Delete"
          confirmVariant="hot"
          busy={busy}
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </Drawer>
  )
}
