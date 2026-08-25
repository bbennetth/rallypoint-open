// Bottom-sheet for capturing a multi-angle progress-picture SET. Slot
// tiles for Front/Back/Side (plus "+ Add angle" custom-pose slots) each
// accept a photo; every filled slot uploads into one shared set (the
// first upload mints the set id, the rest pass it back). Taken-at
// prefills from the FIRST filled slot's EXIF DateTimeOriginal (editable;
// a touched flag stops later slots from clobbering an edit) and is
// shared by the whole set, as is the note. Partial failures keep the
// succeeded slots (never re-sent) and offer a retry for the rest.
// Request/response — no offline story for image bytes.

import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Drawer, ImagePickerField } from '@rallypoint/ui'
import { captureException } from '@rallypoint/web-kit'
import {
  KNOWN_POSES,
  PROGRESS_PHOTO_MAX_BYTES,
  poseLabel,
  poseSchema,
  validateProgressPhotoUpload,
} from '@rallypoint/fitness-shared'
import type { ProgressPhotoDto } from '../lib/api.js'
import { ApiError, listProgressPhotoPoses, uploadProgressPhoto } from '../lib/api.js'
import { downscaleImage } from '../lib/image.js'
import { fileExifDate } from '../lib/exif.js'
import { datetimeLocalToIso, isoToDatetimeLocal, nowDatetimeLocal } from '../lib/metric-view.js'

// Progress pictures keep more detail than the AI-scan payloads (they're
// for the user's own eyes, not a vision model) but still cap the longest
// edge so a 48 MP phone original comfortably clears the 10 MB limit.
const PHOTO_MAX_EDGE_PX = 2048

const NOTE_MAX = 2000

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Could not upload that photo.'
}

// Lowercase-slugify free text ("Side Flexed" → "side_flexed").
function slugifyPose(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 40)
}

type SlotStatus = 'empty' | 'ready' | 'uploading' | 'done' | 'failed'

interface Slot {
  pose: string
  file: File | null
  status: SlotStatus
  dto?: ProgressPhotoDto | undefined
}

export interface ProgressPhotoSheetProps {
  onClose: () => void
  // Fired once after the batch with every photo that made it up.
  onSaved: (photos: ProgressPhotoDto[]) => void
}

export function ProgressPhotoSheet({ onClose, onSaved }: ProgressPhotoSheetProps) {
  const [slots, setSlots] = useState<Slot[]>(
    KNOWN_POSES.map((p) => ({ pose: p.id, file: null, status: 'empty' })),
  )
  const [newPoseOpen, setNewPoseOpen] = useState(false)
  const [newPoseText, setNewPoseText] = useState('')
  const [takenAt, setTakenAt] = useState(nowDatetimeLocal())
  // Refs, not state: the async EXIF lookup must see the LIVE touched/
  // applied flags when it resolves, not the values captured when the
  // file was picked — otherwise a manual edit made while the file is
  // still being read would be clobbered by the late prefill.
  const takenAtTouchedRef = useRef(false)
  const exifAppliedRef = useRef(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Suggest the user's previously used custom slugs as extra slots.
  const [customSuggestions, setCustomSuggestions] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    listProgressPhotoPoses()
      .then((poses) => {
        if (cancelled) return
        const curated = new Set(KNOWN_POSES.map((p) => p.id))
        setCustomSuggestions(poses.filter((p) => !curated.has(p)))
      })
      .catch(() => undefined) // suggestions degrade to the curated three
    return () => {
      cancelled = true
    }
  }, [])

  function updateSlot(index: number, patch: Partial<Slot>) {
    setSlots((cur) => cur.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  function handleFile(index: number, f: File | null) {
    setError(null)
    if (!f) {
      updateSlot(index, { file: null, status: 'empty', dto: undefined })
      return
    }
    updateSlot(index, { file: f, status: 'ready', dto: undefined })
    // EXIF from the first filled slot prefills taken-at; never clobber a
    // user edit or an already-applied prefill (live refs — see above).
    if (!takenAtTouchedRef.current && !exifAppliedRef.current) {
      void fileExifDate(f).then((d) => {
        if (d && !takenAtTouchedRef.current && !exifAppliedRef.current) {
          exifAppliedRef.current = true
          setTakenAt(isoToDatetimeLocal(d.toISOString()))
        }
      })
    }
  }

  function addAngleSlot() {
    const slug = slugifyPose(newPoseText)
    if (!poseSchema.safeParse(slug).success) {
      setError('Pose must contain at least one letter or digit.')
      return
    }
    if (slots.some((s) => s.pose === slug)) {
      setError(`There is already a ${poseLabel(slug)} slot.`)
      return
    }
    setError(null)
    setSlots((cur) => [...cur, { pose: slug, file: null, status: 'empty' }])
    setNewPoseOpen(false)
    setNewPoseText('')
  }

  function addSuggestedSlot(slug: string) {
    if (slots.some((s) => s.pose === slug)) return
    setSlots((cur) => [...cur, { pose: slug, file: null, status: 'empty' }])
  }

  const filled = slots.filter((s) => s.file && s.status !== 'done')
  const doneCount = slots.filter((s) => s.status === 'done').length
  const hasFailed = slots.some((s) => s.status === 'failed')

  async function handleSave() {
    const pending = slots
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => slot.file && (slot.status === 'ready' || slot.status === 'failed'))
    if (pending.length === 0 && doneCount === 0) {
      setError('Add at least one photo first.')
      return
    }
    if (!takenAt) {
      setError('Pick a date and time.')
      return
    }
    setError(null)
    setSaving(true)

    // All slots share the set: reuse an id from an already-done slot
    // (retry pass), else the first success mints it.
    let setId = slots.find((s) => s.dto?.setId)?.dto!.setId ?? undefined
    const uploaded: ProgressPhotoDto[] = slots
      .filter((s): s is Slot & { dto: ProgressPhotoDto } => s.dto !== undefined)
      .map((s) => s.dto)
    let anyFailed = false

    for (const { slot, index } of pending) {
      updateSlot(index, { status: 'uploading' })
      try {
        const blob = await downscaleImage(slot.file!, PHOTO_MAX_EDGE_PX)
        const check = validateProgressPhotoUpload({
          contentType: blob.type || slot.file!.type,
          contentLength: blob.size,
        })
        if (!check.ok) {
          throw new ApiError(
            check.code,
            check.code === 'unsupported_photo_type'
              ? `${poseLabel(slot.pose)}: that image type is not supported — use a JPEG, PNG, or WebP.`
              : `${poseLabel(slot.pose)}: photo is too large (${Math.round(PROGRESS_PHOTO_MAX_BYTES / (1024 * 1024))} MB max).`,
            400,
          )
        }
        const meta: Parameters<typeof uploadProgressPhoto>[1] = {
          pose: slot.pose,
          takenAt: datetimeLocalToIso(takenAt),
        }
        const trimmedNote = note.trim()
        if (trimmedNote) meta.note = trimmedNote
        if (setId) meta.setId = setId
        const dto = await uploadProgressPhoto(blob, meta)
        setId = dto.setId ?? setId
        uploaded.push(dto)
        updateSlot(index, { status: 'done', dto })
      } catch (err: unknown) {
        anyFailed = true
        captureException(err, {
          feature: 'progress_photo',
          image_bytes: slot.file!.size,
          image_mime: slot.file!.type || 'unknown',
        })
        setError(errMessage(err))
        updateSlot(index, { status: 'failed' })
      }
    }

    setSaving(false)
    if (!anyFailed) {
      onSaved(uploaded)
      onClose()
    }
    // On partial failure the sheet stays open: done slots keep their
    // checkmark and are never re-sent; Save becomes "Retry failed".
  }

  const labelStyle = {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--ink-mute)',
  } as const

  const unusedSuggestions = customSuggestions.filter((slug) => !slots.some((s) => s.pose === slug))

  return (
    <Drawer open mobileSheet title="Progress pictures" onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Angles — tap each to add a photo</span>
          <div className="pp-slot-grid">
            {slots.map((slot, i) => (
              <ImagePickerField
                key={slot.pose}
                variant="tile"
                label={poseLabel(slot.pose)}
                file={slot.file}
                onChange={(file) => handleFile(i, file)}
                disabled={saving || slot.status === 'done'}
                status={
                  slot.status === 'uploading'
                    ? 'working'
                    : slot.status === 'done'
                      ? 'success'
                      : slot.status === 'failed'
                        ? 'error'
                        : slot.file
                          ? 'success'
                          : 'idle'
                }
                error={slot.status === 'failed' ? 'Upload failed. Retry when ready.' : undefined}
              />
            ))}
            <Button variant="ghost" onClick={() => setNewPoseOpen((v) => !v)} disabled={saving}>
              Add angle
            </Button>
          </div>
          {newPoseOpen && (
            <div style={{ display: 'grid', gap: 6 }}>
              {unusedSuggestions.length > 0 && (
                <div className="day-chips">
                  {unusedSuggestions.map((slug) => (
                    <button
                      key={slug}
                      type="button"
                      className="day-chip"
                      onClick={() => {
                        addSuggestedSlot(slug)
                        setNewPoseOpen(false)
                      }}
                    >
                      {poseLabel(slug)}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6 }}>
                <input
                  className="pl-input"
                  placeholder="e.g. side flexed"
                  value={newPoseText}
                  maxLength={40}
                  onChange={(e) => setNewPoseText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addAngleSlot()
                    }
                  }}
                />
                <button type="button" className="fit-startbtn ghost" onClick={addAngleSlot}>
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Taken at (all angles)</span>
          <input
            className="pl-input"
            type="datetime-local"
            value={takenAt}
            onChange={(e) => {
              takenAtTouchedRef.current = true
              setTakenAt(e.target.value)
            }}
          />
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Note (optional)</span>
          <input
            className="pl-input"
            placeholder="e.g. end of cut, week 6"
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        <div className="btn-row">
          <button type="button" className="fit-startbtn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="fit-startbtn"
            onClick={handleSave}
            disabled={saving || (filled.length === 0 && !hasFailed)}
          >
            {saving
              ? 'Uploading…'
              : hasFailed
                ? 'Retry failed'
                : filled.length > 1
                  ? `Save ${filled.length} photos`
                  : 'Save photo'}
          </button>
        </div>
      </div>
    </Drawer>
  )
}
