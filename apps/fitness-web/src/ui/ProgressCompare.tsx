// Compare drawer: two progress photos side by side (older left, newer
// right) with nearest-bodyweight captions, a delta line, and a
// share/export action that composes the branded 1080×1350 JPEG via
// progress-export.ts. Follows ProgressPhotoDetail's Drawer conventions.

import { useEffect, useMemo, useState } from 'react'
import { Banner, Drawer } from '@rallypoint/ui'
import { poseLabel } from '@rallypoint/fitness-shared'
import type { ProgressPhotoDto } from '../lib/api.js'
import { ApiError, metricsQuery, progressPhotoImageUrl } from '../lib/api.js'
import { formatValue, nearestMetricTo } from '../lib/metric-view.js'
import { kgToDisplay, useWeightUnit, type WeightUnit } from '../lib/units.js'
import {
  progressExportFileName,
  renderProgressExport,
  shareOrDownload,
  type ExportPhotoInput,
} from '../lib/progress-export.js'

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback
}

function dateDisplay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

// Whole weeks when the gap is at least 2 weeks; otherwise days (so a
// 9-day gap doesn't round down to "1 week").
export function spanText(olderIso: string, newerIso: string): string {
  const older = new Date(olderIso)
  const newer = new Date(newerIso)
  const sameLocalDay =
    older.getFullYear() === newer.getFullYear() &&
    older.getMonth() === newer.getMonth() &&
    older.getDate() === newer.getDate()
  if (sameLocalDay) return 'same day'
  // Different local days → at least "1 day", even if under 24h apart.
  const days = Math.max(1, Math.round((newer.getTime() - older.getTime()) / (24 * 60 * 60 * 1000)))
  if (days < 14) return days === 1 ? '1 day' : `${days} days`
  const weeks = Math.round(days / 7)
  return weeks === 1 ? '1 week' : `${weeks} weeks`
}

// "+2.3 lb" / "−1.1 kg" delta between two stored-kg readings, rendered
// at the same 1-dp precision bodyweight uses everywhere else.
function deltaText(olderKg: number, newerKg: number, unit: WeightUnit): string {
  const olderDisplay = kgToDisplay(olderKg, unit, 1)
  const newerDisplay = kgToDisplay(newerKg, unit, 1)
  const diff = Math.round((newerDisplay - olderDisplay) * 10) / 10
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
  return `${sign}${Math.abs(diff).toFixed(1)} ${unit}`
}

export interface ProgressCompareProps {
  open: boolean
  photos: [ProgressPhotoDto, ProgressPhotoDto] | null
  onClose: () => void
  // "Change photos" — returns to selection mode without leaving compare.
  onChangePhotos: () => void
}

interface Pair {
  older: ProgressPhotoDto
  newer: ProgressPhotoDto
}

export function ProgressCompare({ open, photos, onClose, onChangePhotos }: ProgressCompareProps) {
  const weightUnit = useWeightUnit()
  const [weightsById, setWeightsById] = useState<Record<string, number | null> | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [sharing, setSharing] = useState(false)

  const pair = useMemo<Pair | null>(() => {
    if (!photos) return null
    const [a, b] = photos
    return a.takenAt <= b.takenAt ? { older: a, newer: b } : { older: b, newer: a }
  }, [photos])

  // Fetch bodyweight metrics once per open, then pre-render the export
  // (Web Share must be invoked synchronously from the click, on iOS, so
  // the blob has to be ready ahead of time rather than built on demand).
  useEffect(() => {
    if (!open || !pair) {
      setWeightsById(null)
      setBlob(null)
      setError(null)
      setSharing(false) // a share promise that never settled must not wedge the next open
      return
    }
    let cancelled = false
    setPreparing(true)
    setError(null)
    setBlob(null)
    ;(async () => {
      try {
        // Reuse the app's standard bodyweight metrics query/key (same one
        // BodyView/LogPage warm) rather than a bespoke {kind,limit} filter,
        // so this doesn't create a second, out-of-sync cache entry.
        const allMetrics = await metricsQuery().fetch()
        const metrics = allMetrics.filter((m) => m.kind === 'bodyweight')
        if (cancelled) return
        const olderKg = nearestMetricTo(pair.older.takenAt, metrics)?.value ?? null
        const newerKg = nearestMetricTo(pair.newer.takenAt, metrics)?.value ?? null
        setWeightsById({ [pair.older.id]: olderKg, [pair.newer.id]: newerKg })

        const weightText = (kg: number | null): string | null =>
          kg == null ? null : formatValue(kgToDisplay(kg, weightUnit, 1), weightUnit)

        const exportPhotos: ExportPhotoInput[] = [
          {
            url: progressPhotoImageUrl(pair.older.id),
            dateText: dateDisplay(pair.older.takenAt),
            weightText: weightText(olderKg),
          },
          {
            url: progressPhotoImageUrl(pair.newer.id),
            dateText: dateDisplay(pair.newer.takenAt),
            weightText: weightText(newerKg),
          },
        ]
        const delta = olderKg != null && newerKg != null ? deltaText(olderKg, newerKg, weightUnit) : null
        const rendered = await renderProgressExport(exportPhotos, { deltaText: delta })
        if (cancelled) return
        setBlob(rendered)
      } catch (err) {
        if (cancelled) return
        setError(errMessage(err, 'Could not prepare the comparison image.'))
      } finally {
        if (!cancelled) setPreparing(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, pair?.older.id, pair?.newer.id, weightUnit])

  async function handleShare() {
    if (!blob || !pair || sharing) return
    setSharing(true)
    setError(null)
    try {
      await shareOrDownload(blob, progressExportFileName([pair.older, pair.newer]))
    } catch (err) {
      setError(errMessage(err, 'Could not share that image.'))
    } finally {
      setSharing(false)
    }
  }

  if (!pair) return null

  const olderWeight = weightsById?.[pair.older.id] ?? null
  const newerWeight = weightsById?.[pair.newer.id] ?? null
  const bothKnown = olderWeight != null && newerWeight != null
  const differentPoses = pair.older.pose !== pair.newer.pose

  return (
    <Drawer open={open} mobileSheet mobileFull title="Compare" onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}

        <div className="pp-compare-grid">
          <figure className="pp-compare-col">
            <img src={progressPhotoImageUrl(pair.older.id)} alt={poseLabel(pair.older.pose)} />
            <figcaption>
              <span className="pp-compare-date">{dateDisplay(pair.older.takenAt)}</span>
              <span className="pp-compare-weight">
                {olderWeight == null ? '—' : formatValue(kgToDisplay(olderWeight, weightUnit, 1), weightUnit)}
              </span>
            </figcaption>
          </figure>
          <figure className="pp-compare-col">
            <img src={progressPhotoImageUrl(pair.newer.id)} alt={poseLabel(pair.newer.pose)} />
            <figcaption>
              <span className="pp-compare-date">{dateDisplay(pair.newer.takenAt)}</span>
              <span className="pp-compare-weight">
                {newerWeight == null ? '—' : formatValue(kgToDisplay(newerWeight, weightUnit, 1), weightUnit)}
              </span>
            </figcaption>
          </figure>
        </div>

        <div className="pp-compare-delta">
          {spanText(pair.older.takenAt, pair.newer.takenAt)}
          {bothKnown && <> · {deltaText(olderWeight!, newerWeight!, weightUnit)}</>}
          {differentPoses && <span className="pp-compare-note"> · different poses</span>}
        </div>

        <div className="btn-row">
          <button type="button" className="fit-startbtn ghost" onClick={onChangePhotos}>
            Change photos
          </button>
          <button
            type="button"
            className="fit-startbtn"
            onClick={() => void handleShare()}
            disabled={!blob || preparing || sharing}
          >
            {preparing ? 'Preparing…' : 'Share image'}
          </button>
        </div>
      </div>
    </Drawer>
  )
}
