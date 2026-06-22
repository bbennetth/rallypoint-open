import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  deleteChoreItem,
  getChoresList,
  listChoreItems,
  listChoreSeries,
  setChoreItemCompleted,
  type ChoreItemDto,
  type ChoreListDto,
  type TaskSeriesDto,
} from '../lib/api.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Drawer } from '@rallypoint/ui'
import { Check } from '../ui/bits.js'
import { SkeletonBlock, SkeletonRows } from '../ui/Skeleton.js'
import { Icon } from '../ui/icons.js'
import { SeriesEdit } from '../ui/SeriesEdit.js'
import { SeriesList } from '../ui/SeriesList.js'

// Chores surface (#546), rendered as the "Chores" sub-view of the Tasks page.
// A single system-managed `chores`-type list per user, auto-provisioned on first
// access. Every chore is a recurring series — one-offs were removed when Tasks
// became one-off-only and recurrence moved here. All persistence lives in Lists
// via the planner-api BFF; the list is system-managed (not deletable). The pure
// recurrence-form → series-input mapping lives in buildChoreSeriesInput.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

// dueDate is a genuine instant (the BFF resolves each chore occurrence's floating
// wall-clock due into the request tz), so its local calendar date formats
// directly — a chore that falls on the 12th reads as the 12th in any zone.
function dueLabel(dueDate: string | null): string {
  if (!dueDate) return ''
  const d = new Date(dueDate)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ChoresBody() {
  const [list, setList] = useState<ChoreListDto | null>(null)
  const [items, setItems] = useState<ChoreItemDto[]>([])
  const [series, setSeries] = useState<TaskSeriesDto[]>([])
  const [editSeries, setEditSeries] = useState<TaskSeriesDto | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingItems, setLoadingItems] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshList = useCallback(async () => {
    setLoadingList(true)
    try {
      setList(await getChoresList())
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  const refreshItems = useCallback(async (listId: string) => {
    setLoadingItems(true)
    try {
      setItems(await listChoreItems(listId))
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoadingItems(false)
    }
  }, [])

  const refreshSeries = useCallback(async (listId: string) => {
    try {
      setSeries(await listChoreSeries(listId))
    } catch (err) {
      setError(errMessage(err))
    }
  }, [])

  useEffect(() => {
    if (list) {
      void refreshItems(list.id)
      void refreshSeries(list.id)
    } else {
      setItems([])
      setSeries([])
    }
  }, [list, refreshItems, refreshSeries])

  // A chore added from the global quick-add FAB refreshes the list.
  useEffect(
    () =>
      onCreated('chore', () => {
        if (list) {
          void refreshItems(list.id)
          void refreshSeries(list.id)
        }
      }),
    [list, refreshItems, refreshSeries],
  )

  async function onToggle(item: ChoreItemDto) {
    if (!list) return
    setError(null)
    try {
      const updated = await setChoreItemCompleted(list.id, item.id, !item.completed)
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onDelete(item: ChoreItemDto) {
    if (!list) return
    setError(null)
    try {
      await deleteChoreItem(list.id, item.id)
      setItems((prev) => prev.filter((i) => i.id !== item.id))
    } catch (err) {
      setError(errMessage(err))
    }
  }

  const doneCount = items.filter((i) => i.completed).length
  const seriesById = useMemo(() => new Map(series.map((s) => [s.id, s])), [series])

  if (loadingList) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading chores" style={{ display: 'grid', gap: 12 }}>
        <SkeletonBlock height={44} />
        <SkeletonBlock height={180} />
        <SkeletonRows count={3} height={44} bare />
      </div>
    )
  }

  return (
    <>
      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="meta" style={{ color: 'var(--ink-mute)' }}>
            {doneCount} / {items.length} done
          </span>
          <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          <button
            type="button"
            className="pl-btn ghost sm"
            onClick={() => setManageOpen(true)}
          >
            <Icon name="repeat" size={12} />
            Series{series.length > 0 ? ` · ${series.length}` : ''}
          </button>
        </div>

        {loadingItems ? (
          <SkeletonRows count={3} height={44} label="Loading chores" />
        ) : items.length === 0 ? (
          <p className="meta" style={{ color: 'var(--ink-mute)' }}>
            Nothing here yet — use the + button to add one.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
            {items.map((item) => {
              const due = dueLabel(item.dueDate)
              return (
                <li
                  key={item.id}
                  className="pl-row"
                  style={{ gridTemplateColumns: '20px 1fr auto', alignItems: 'center', gap: 8 }}
                >
                  <Check done={item.completed} onClick={() => void onToggle(item)} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 14,
                      color: item.completed ? 'var(--ink-mute)' : 'var(--ink)',
                      textDecoration: item.completed ? 'line-through' : 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    {item.title}
                    {item.seriesId &&
                      (() => {
                        const sr = seriesById.get(item.seriesId)
                        return (
                          <span
                            className="pl-chip repeat"
                            role={sr ? 'button' : undefined}
                            tabIndex={sr ? 0 : undefined}
                            title={sr ? 'Edit series' : undefined}
                            onClick={
                              sr
                                ? (e) => {
                                    e.stopPropagation()
                                    setEditSeries(sr)
                                  }
                                : undefined
                            }
                            onKeyDown={
                              sr
                                ? (e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      setEditSeries(sr)
                                    }
                                  }
                                : undefined
                            }
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              cursor: sr ? 'pointer' : 'default',
                            }}
                          >
                            <Icon name="repeat" size={10} />
                            {sr ? 'Edit series' : 'Recurring'}
                          </span>
                        )
                      })()}
                    {due && (
                      <span className="meta" style={{ color: 'var(--ink-mute)' }}>
                        {due}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="pl-iconbtn danger"
                    onClick={() => void onDelete(item)}
                    aria-label={`Delete ${item.title}`}
                    title="Delete"
                  >
                    ✕
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <Drawer
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        title="Recurring chores"
        width={420}
        mobileSheet
      >
        <SeriesList
          series={series}
          onEdit={(sr) => {
            setManageOpen(false)
            setEditSeries(sr)
          }}
          emptyLabel="No recurring chores yet — use the + button to add one."
        />
      </Drawer>

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
            onChanged={() => {
              void refreshItems(list.id)
              void refreshSeries(list.id)
            }}
            onClose={() => setEditSeries(null)}
          />
        )}
      </Drawer>
    </>
  )
}
