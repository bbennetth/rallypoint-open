// PROGRESS PICTURES section for BodyView: a horizontal filmstrip of the
// most recent photos (`.saved-shelf` scroll recipe), an add button, and
// a "view all" link to the /stats/photos gallery. Owns the capture
// sheet + lightbox for this surface; list state is plain
// request/response (refetched after each mutation) per the food-logger
// convention — no offline story for image bytes.

import { useCallback, useEffect, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Banner } from '@rallypoint/ui'
import { groupPhotosBySet, poseLabel, primaryPhotoOfSet } from '@rallypoint/fitness-shared'
import type { ProgressPhotoSet } from '@rallypoint/fitness-shared'
import type { ProgressPhotoDto } from '../lib/api.js'
import { ApiError, listProgressPhotos, progressPhotoImageUrl } from '../lib/api.js'
import { ProgressPhotoDetail } from './ProgressPhotoDetail.js'
import { ProgressPhotoSheet } from './ProgressPhotoSheet.js'

// Fetch a few more rows than tiles shown — sets collapse multiple rows
// into one tile.
const STRIP_LIMIT = 24

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load progress pictures.'
}

function stripLabel(photo: ProgressPhotoDto): string {
  const day = new Date(photo.takenAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
  return `${day} · ${poseLabel(photo.pose)}`
}

export function ProgressPhotosCard() {
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [photos, setPhotos] = useState<ProgressPhotoDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [selected, setSelected] = useState<ProgressPhotoSet<ProgressPhotoDto> | null>(null)

  const run = useAsyncTask()
  const refetch = useCallback(() => {
    // Also called from the capture-sheet / detail mutation callbacks; the gate
    // makes a later refetch supersede an in-flight one cleanly.
    void run(async (ctx) => {
      try {
        const res = await listProgressPhotos({ limit: STRIP_LIMIT })
        if (ctx.stale()) return
        setPhotos(res.items)
        setError(null)
      } catch (err: unknown) {
        if (ctx.stale()) return
        setError(errMessage(err))
      }
    })
  }, [run])

  useEffect(() => {
    refetch()
  }, [refetch])

  // StartSheet-style deep link: /stats/body?photo=1 opens the capture
  // sheet on arrival (mirrors ?log=1 for MetricLogSheet).
  const wantsPhoto = searchParams.get('photo') === '1'
  useEffect(() => {
    if (wantsPhoto) {
      setSheetOpen(true)
      setSearchParams(
        (cur) => {
          const next = new URLSearchParams(cur)
          next.delete('photo')
          return next
        },
        { replace: true },
      )
    }
  }, [wantsPhoto, setSearchParams])

  const loading = photos === null && !error

  return (
    <section style={{ display: 'grid', gap: 8 }}>
      <div className="sec-rule">
        <div className="eyebrow">PROGRESS PICTURES</div>
        <div className="line" />
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {loading ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : photos && photos.length > 0 ? (
        <>
          <div className="saved-shelf" role="list" aria-label="Recent progress pictures">
            {groupPhotosBySet(photos).map((set) => {
              const primary = primaryPhotoOfSet(set.photos)
              return (
                <button
                  key={set.setKey}
                  type="button"
                  role="listitem"
                  className="pp-thumb"
                  onClick={() => setSelected(set)}
                  aria-label={`Open progress pictures — ${stripLabel(primary)}${set.photos.length > 1 ? `, ${set.photos.length} angles` : ''}`}
                >
                  <span className="pp-thumb-imgwrap">
                    <img src={progressPhotoImageUrl(primary.id)} alt="" loading="lazy" />
                    {set.photos.length > 1 && (
                      <span className="pp-badge">{set.photos.length} angles</span>
                    )}
                  </span>
                  <span className="pp-thumb-k">{stripLabel(primary)}</span>
                </button>
              )
            })}
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => nav('/stats/photos')}
            >
              View all
            </button>
            <button type="button" className="fit-startbtn" onClick={() => setSheetOpen(true)}>
              + Add photo
            </button>
          </div>
        </>
      ) : (
        <div className="pp-empty">
          <div style={{ fontSize: 14, color: 'var(--ink-dim)' }}>
            No progress pictures yet. Front, back, side — future you will want the receipts.
          </div>
          <button type="button" className="fit-startbtn" onClick={() => setSheetOpen(true)}>
            Take the first photo
          </button>
        </div>
      )}

      {sheetOpen && (
        <ProgressPhotoSheet onClose={() => setSheetOpen(false)} onSaved={() => refetch()} />
      )}
      {selected && (
        <ProgressPhotoDetail
          photos={selected.photos}
          customPoses={[]}
          onClose={() => setSelected(null)}
          onChanged={() => refetch()}
          onDeleted={() => refetch()}
        />
      )}
    </section>
  )
}
