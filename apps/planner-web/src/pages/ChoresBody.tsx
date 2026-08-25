import { useEffect, useMemo, useState } from 'react'
import { ApiError, choresListQuery, choreSeriesQuery, type TaskSeriesDto } from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Drawer } from '@rallypoint/ui'
import { SkeletonRows } from '../ui/Skeleton.js'
import { SeriesEdit } from '../ui/SeriesEdit.js'
import { SeriesList } from '../ui/SeriesList.js'

// Chores surface (#546), rendered as the "Chores" sub-view of the Tasks page.
// A single system-managed `chores`-type list per user, auto-provisioned on first
// access. Every chore is a recurring series — the tab shows the SERIES (the
// recurring definitions), not upcoming occurrences; checking off individual
// occurrences happens in My Day / Upcoming. All persistence lives in Lists via
// the planner-api BFF; the list is system-managed (not deletable). The pure
// recurrence-form → series-input mapping lives in buildChoreSeriesInput.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

export function ChoresBody() {
  // Render-from-cache: both reads paint the last-known value instantly
  // (skeletons only on a true cold cache miss) and re-render on every
  // cache write.
  const listQ = useCachedQuery(useMemo(() => choresListQuery(), []))
  const list = listQ.data ?? null
  const listId = list?.id ?? null
  const seriesQ = useCachedQuery(useMemo(() => (listId ? choreSeriesQuery(listId) : null), [listId]))
  const series = useMemo(() => seriesQ.data ?? [], [seriesQ.data])

  const [editSeries, setEditSeries] = useState<TaskSeriesDto | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadingList = listQ.status === 'loading'
  const loadingSeries = listId !== null && seriesQ.status === 'loading'

  useEffect(() => {
    if (listQ.status === 'error') setError(errMessage(listQ.error))
    else if (seriesQ.status === 'error') setError(errMessage(seriesQ.error))
  }, [listQ.status, listQ.error, seriesQ.status, seriesQ.error])

  // A chore added from the global quick-add FAB refreshes the series list.
  const refetchSeries = seriesQ.refetch
  useEffect(() => onCreated('chore', () => void refetchSeries()), [refetchSeries])

  if (loadingList || loadingSeries) {
    return <SkeletonRows count={3} height={56} label="Loading chores" />
  }

  return (
    <>
      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      <SeriesList
        series={series}
        onEdit={(sr) => setEditSeries(sr)}
        emptyLabel="No recurring chores yet — use the + button to add one."
      />

      <Drawer
        open={editSeries !== null}
        onClose={() => setEditSeries(null)}
        title="Edit series"
        mobileSheet
      >
        {editSeries && list && (
          <SeriesEdit
            series={editSeries}
            surface="chores"
            onChanged={() => void refetchSeries()}
            onClose={() => setEditSeries(null)}
          />
        )}
      </Drawer>
    </>
  )
}
