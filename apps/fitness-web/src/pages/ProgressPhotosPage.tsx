// /stats/photos — the full progress-picture gallery: photos grouped by
// calendar day (newest first), pose filter chips, cursor-based "load
// more". Reached from BodyView's PROGRESS PICTURES card; back link
// returns to /stats/body. Plain request/response state, refetched
// after each mutation (food-logger convention).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Banner, EmptyState } from '@rallypoint/ui'
import {
  KNOWN_POSES,
  groupPhotosByDay,
  groupPhotosBySet,
  poseLabel,
  primaryPhotoOfSet,
} from '@rallypoint/fitness-shared'
import type { ProgressPhotoSet } from '@rallypoint/fitness-shared'
import type { ProgressPhotoDto } from '../lib/api.js'
import {
  ApiError,
  listProgressPhotoPoses,
  listProgressPhotos,
  progressPhotoImageUrl,
} from '../lib/api.js'
import { ProgressPhotoDetail } from '../ui/ProgressPhotoDetail.js'
import { ProgressPhotoSheet } from '../ui/ProgressPhotoSheet.js'

const PAGE_SIZE = 60

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load progress pictures.'
}

function dayHeading(dayKey: string): string {
  // dayKey is a local YYYY-MM-DD; render it via a local-noon Date so the
  // heading never slips a day across timezones.
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y!, m! - 1, d!, 12).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

export function ProgressPhotosPage() {
  const [photos, setPhotos] = useState<ProgressPhotoDto[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [poses, setPoses] = useState<string[]>(KNOWN_POSES.map((p) => p.id))
  const [poseFilter, setPoseFilter] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [selected, setSelected] = useState<{
    set: ProgressPhotoSet<ProgressPhotoDto>
    initialPhotoId: string
  } | null>(null)
  // Monotonic request generation: a pose-filter flip (or refetch) bumps
  // it so an in-flight load-more that resolves late can't append rows
  // from the previous filter.
  const genRef = useRef(0)
  const run = useAsyncTask()

  const refetch = useCallback(
    (pose: string | null) => {
      // Still bumped unconditionally — `loadMore` (below) reads this ref
      // directly to detect a superseding refetch, independent of this
      // loader's own `run` generation gate.
      genRef.current++
      void run(async (ctx) => {
        try {
          const res = await listProgressPhotos({ limit: PAGE_SIZE, ...(pose ? { pose } : {}) })
          if (ctx.stale()) return
          setPhotos(res.items)
          setCursor(res.next_cursor)
          setError(null)
        } catch (err: unknown) {
          if (ctx.stale()) return
          setError(errMessage(err))
        }
      })
    },
    [run],
  )

  useEffect(() => {
    refetch(poseFilter)
  }, [refetch, poseFilter])

  useEffect(() => {
    listProgressPhotoPoses()
      .then(setPoses)
      .catch(() => undefined) // filter chips degrade to the curated three
  }, [])

  async function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    const gen = genRef.current
    try {
      const res = await listProgressPhotos({
        limit: PAGE_SIZE,
        cursor,
        ...(poseFilter ? { pose: poseFilter } : {}),
      })
      if (gen !== genRef.current) return
      setPhotos((cur) => [...(cur ?? []), ...res.items])
      setCursor(res.next_cursor)
    } catch (err: unknown) {
      // Match the success path's guard: a stale load-more that rejects after a
      // refetch superseded it must not paint an error over the fresher list.
      if (gen !== genRef.current) return
      setError(errMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const groups = useMemo(() => groupPhotosByDay(photos ?? []), [photos])
  const customPoses = poses.filter((p) => !KNOWN_POSES.some((k) => k.id === p))
  const loading = photos === null && !error

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="top">
          <div>
            <Link
              to="/stats/body"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--ink-mute)',
                textDecoration: 'none',
              }}
            >
              <span aria-hidden="true">←</span> Body stats
            </Link>
            <h1>Progress pictures</h1>
          </div>
          <button type="button" className="fit-startbtn ghost" onClick={() => setSheetOpen(true)}>
            + Add photo
          </button>
        </div>
      </header>

      <div className="day-chips" role="radiogroup" aria-label="Filter by pose">
        <button
          type="button"
          role="radio"
          aria-checked={poseFilter === null}
          className={`day-chip${poseFilter === null ? ' on' : ''}`}
          onClick={() => setPoseFilter(null)}
        >
          All
        </button>
        {poses.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={poseFilter === p}
            className={`day-chip${poseFilter === p ? ' on' : ''}`}
            onClick={() => setPoseFilter(p)}
          >
            {poseLabel(p)}
          </button>
        ))}
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {loading ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : groups.length === 0 ? (
        <EmptyState
          title="No progress pictures yet"
          body="Take a front, back, and side photo to start the timeline."
          action={
            <button type="button" className="fit-startbtn" onClick={() => setSheetOpen(true)}>
              Take the first photo
            </button>
          }
        />
      ) : (
        <div style={{ display: 'grid', gap: 18 }}>
          {groups.map((g) => (
            <section key={g.dayKey} style={{ display: 'grid', gap: 8 }}>
              <div className="sec-rule">
                <div className="eyebrow">{dayHeading(g.dayKey)}</div>
                <div className="line" />
              </div>
              <div className="pp-grid">
                {groupPhotosBySet(g.photos).map((set) => {
                  const primary = primaryPhotoOfSet(set.photos)
                  return (
                    <button
                      key={set.setKey}
                      type="button"
                      className="pp-thumb"
                      onClick={() => setSelected({ set, initialPhotoId: primary.id })}
                      aria-label={`Open progress pictures — ${poseLabel(primary.pose)}${set.photos.length > 1 ? `, ${set.photos.length} angles` : ''}`}
                    >
                      <span className="pp-thumb-imgwrap">
                        <img src={progressPhotoImageUrl(primary.id)} alt="" loading="lazy" />
                        {set.photos.length > 1 && (
                          <span className="pp-badge">{set.photos.length} angles</span>
                        )}
                      </span>
                      <span className="pp-thumb-k">{poseLabel(primary.pose)}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
          {cursor && (
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}

      {sheetOpen && (
        <ProgressPhotoSheet
          onClose={() => setSheetOpen(false)}
          onSaved={() => refetch(poseFilter)}
        />
      )}
      {selected && (
        <ProgressPhotoDetail
          photos={selected.set.photos}
          initialPhotoId={selected.initialPhotoId}
          customPoses={customPoses}
          onClose={() => setSelected(null)}
          onChanged={() => refetch(poseFilter)}
          onDeleted={() => refetch(poseFilter)}
        />
      )}
    </div>
  )
}
