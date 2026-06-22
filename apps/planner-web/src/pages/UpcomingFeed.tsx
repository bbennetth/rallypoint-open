import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getSettings,
  setGroupEventPlannerPref,
  setTaskItemCompleted,
  updateSettings,
  SHOW_CHORES_IN_FEEDS_KEY,
  type EventDayDto,
  type HolidayDto,
  type MyDayEvent,
  type MyDayTask,
  type TaskSeriesDto,
  type Upcoming,
  type UpcomingItem,
} from '../lib/api.js'
import { choresInFeedsEnabled } from '../lib/chores-helpers.js'
import { upcomingFeedGroups } from '../lib/holidays-helpers.js'
import {
  eventDayWindow,
  fmtTime,
  hasTimeOfDay,
  localYmd,
} from '../lib/planner-helpers.js'
import type { ResolvedSeries, SeriesSurface } from '../lib/series-lookup.js'
import { Drawer } from '@rallypoint/ui'
import { Check, EventEditPencil, EyeRow, PriTag } from '../ui/bits.js'
import { Icon } from '../ui/icons.js'
import { TaskDetail } from '../ui/TaskDetail.js'
import { PersonalEventEdit } from '../ui/PersonalEventEdit.js'
import { EventDayDetail } from '../ui/EventDayDetail.js'
import { HolidayDetail } from '../ui/EventDetail.js'
import { SeriesEdit } from '../ui/SeriesEdit.js'
import { SeriesChip } from '../ui/SeriesChip.js'
import { openProps, stopRowOpen as stop } from '../ui/row-open.js'

type Selected =
  | { kind: 'task'; task: MyDayTask }
  | { kind: 'event'; event: MyDayEvent }
  | { kind: 'eventDay'; eventDay: EventDayDto }
  | { kind: 'holiday'; holiday: HolidayDto }
  | { kind: 'series'; series: TaskSeriesDto; surface: SeriesSurface }

// Upcoming feed (slice 9 + Ink redesign). Presentational: the parent (My Day)
// owns the my-day + upcoming + recurring fetch and passes the data down, so the
// agenda reads as one continuous scroll with no tab/route of its own (the
// Today | Upcoming toggle from #495 is gone). Dated items group by local day
// with relative labels; the list view shows only strictly-future days (today
// already appears in the roll-up above). Week/month calendar lives in the My Day
// calendar lens (the Agenda·Month·Week toggle). Tasks check off optimistically
// against a local mirror; events are read-only here.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

export interface UpcomingFeedProps {
  data: Upcoming | null
  /** Unhidden US holidays for the forward window, interleaved into the feed
   * (read-only). Owned + filtered by the parent so a Hide reflects everywhere. */
  holidays: HolidayDto[]
  /** seriesId → {series, surface} for badging/editing recurring rows. */
  seriesLookup: Map<string, ResolvedSeries>
  /** The chores list id (when a chore occurrence is on screen) so a recurring
   * row's badge reads "Chore" vs "Repeats" without depending on the lookup. */
  choresListId: string | null
  todayYmd: string
  /** Hide a holiday from every Planner surface (persists the setting upstream). */
  onHideHoliday: (h: HolidayDto) => void
  /** Called after a successful mutation so the parent can refetch if it wants. */
  onChanged: () => void
}

export function UpcomingFeed({
  data: dataProp,
  holidays,
  seriesLookup,
  choresListId,
  todayYmd,
  onHideHoliday,
  onChanged,
}: UpcomingFeedProps) {
  // Local optimistic mirror of the parent's upcoming payload, re-synced whenever
  // the parent supplies fresh data. Check-off / remove mutate it in place for a
  // snappy response and revert on failure.
  const [data, setData] = useState<Upcoming | null>(dataProp)
  useEffect(() => setData(dataProp), [dataProp])

  const [error, setError] = useState<string | null>(null)
  // Chores-in-feeds inline toggle (#546). Loaded from the planner settings on
  // mount; flipping it persists the setting and asks the parent to refetch so
  // the feed reflects chores appearing/disappearing immediately.
  const [showChores, setShowChores] = useState<boolean>(true)
  useEffect(() => {
    let cancelled = false
    void getSettings('planner')
      .then((s) => {
        if (!cancelled) setShowChores(choresInFeedsEnabled(s))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  async function onToggleShowChores() {
    const next = !showChores
    setShowChores(next)
    try {
      await updateSettings('planner', { [SHOW_CHORES_IN_FEEDS_KEY]: next })
      onChanged() // re-pull the feed so chores appear/disappear now
    } catch (err) {
      setShowChores(!next)
      setError(errMessage(err))
    }
  }

  const [selected, setSelected] = useState<Selected | null>(null)

  const today = todayYmd
  // The list view renders only strictly-future days; today lives in the roll-up.
  // Holidays are merged in (after each day's tasks/events) so they appear in the
  // feed alongside everything else on the horizon.
  const groups = useMemo(
    () => (data ? upcomingFeedGroups(data.dated, holidays, today) : []),
    [data, holidays, today],
  )

  function patchTask(id: string, completed: boolean) {
    setData((d) => {
      if (!d) return d
      const map = (items: UpcomingItem[]) =>
        items.map((it) =>
          it.kind === 'task' && it.task.id === id ? { ...it, task: { ...it.task, completed } } : it,
        )
      return { ...d, dated: map(d.dated), undated: map(d.undated) }
    })
  }

  // Toggling / removing a forward-looking item only affects this feed, never
  // the Today roll-up above — so we mutate the local mirror and skip the
  // parent refetch (which would re-pull all three endpoints and flash the
  // feed). The mirror re-syncs from props on the next parent-driven refresh.
  async function toggleTask(listId: string, id: string, completed: boolean) {
    const next = !completed
    patchTask(id, next)
    try {
      await setTaskItemCompleted(listId, id, next)
    } catch (err) {
      setError(errMessage(err))
      patchTask(id, completed)
    }
  }

  async function onRemoveEventFromPlanner(eventDay: EventDayDto) {
    setError(null)
    try {
      await setGroupEventPlannerPref(eventDay.eventId, false)
      setData((d) => {
        if (!d) return d
        const filter = (items: UpcomingItem[]) =>
          items.filter(
            (it) => !(it.kind === 'eventDay' && it.eventDay.eventId === eventDay.eventId),
          )
        return { ...d, dated: filter(d.dated), undated: filter(d.undated) }
      })
    } catch (err) {
      setError(errMessage(err))
    }
  }

  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 12,
            color: 'var(--ink-dim)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            role="switch"
            aria-label="Show chores in feed"
            checked={showChores}
            onChange={() => void onToggleShowChores()}
            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
          <Icon name="repeat" size={11} />
          Show chores
        </label>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {data ? (
        <div className="up-grid">
          <div>
            {groups.length === 0 ? (
              <p className="meta" style={{ color: 'var(--ink-mute)' }}>
                Nothing scheduled ahead.
              </p>
            ) : (
              groups.map((g) => (
                <div key={g.ymd}>
                  <div className="pl-dategroup">
                    <span className="d">{g.dateLabel}</span>
                    <span className="rel">{g.rel}</span>
                    <span className="ln" />
                  </div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 7 }}>
                    {g.items.map((it) => {
                      if (it.kind === 'holiday') {
                        const h = it.holiday
                        return (
                          <li
                            key={`holiday:${h.id}`}
                            className="pl-row"
                            {...openProps(() => setSelected({ kind: 'holiday', holiday: h }))}
                            style={{
                              gridTemplateColumns: '1fr auto',
                              alignItems: 'center',
                              cursor: 'pointer',
                            }}
                          >
                            <span
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 5,
                                minWidth: 0,
                              }}
                            >
                              <span style={{ fontSize: 13.5, color: 'var(--ink)' }}>{h.name}</span>
                              <span
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 7,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span className="eyebrow" style={{ color: 'var(--ink-mute)' }}>
                                  holiday
                                </span>
                              </span>
                            </span>
                          </li>
                        )
                      }
                      if (it.kind === 'eventDay') {
                        const ed = it.eventDay
                        const allDay = ed.startTime == null
                        return (
                          <li
                            key={`eventDay:${ed.eventId}@${ed.date}`}
                            className="pl-row"
                            {...openProps(() => setSelected({ kind: 'eventDay', eventDay: ed }))}
                            style={{
                              gridTemplateColumns: '1fr auto',
                              alignItems: 'center',
                              cursor: 'pointer',
                            }}
                          >
                            <span
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 5,
                                minWidth: 0,
                              }}
                            >
                              <span style={{ fontSize: 13.5, color: 'var(--ink)' }}>{ed.name}</span>
                              <span
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 7,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span className="eyebrow" style={{ color: 'var(--acid)' }}>
                                  event
                                </span>
                                {ed.dayLabel && (
                                  <span className="meta" style={{ color: 'var(--ink-mute)' }}>
                                    {ed.dayLabel}
                                  </span>
                                )}
                                {allDay && <span className="pl-chip">All day</span>}
                                {ed.shared && (
                                  <span
                                    className="pl-chip"
                                    style={{
                                      borderColor: 'var(--acid-dim, var(--acid))',
                                      color: 'var(--acid)',
                                    }}
                                  >
                                    Shared
                                  </span>
                                )}
                              </span>
                            </span>
                            <span
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 9,
                                alignSelf: 'flex-start',
                              }}
                            >
                              {!allDay && (
                                <span
                                  className="mono"
                                  style={{ fontSize: 12, color: 'var(--ink-dim)' }}
                                >
                                  {eventDayWindow(ed.startTime, ed.endTime)}
                                </span>
                              )}
                              {ed.shared ? (
                                <span onClick={stop} style={{ display: 'flex' }}>
                                  <button
                                    type="button"
                                    className="pl-donebtn"
                                    onClick={() => void onRemoveEventFromPlanner(ed)}
                                    aria-label={`Remove ${ed.name} from Planner`}
                                    style={{ flexShrink: 0 }}
                                  >
                                    Remove
                                  </button>
                                </span>
                              ) : ed.owned ? (
                                <span onClick={stop} style={{ display: 'flex' }}>
                                  <EventEditPencil slug={ed.slug} />
                                </span>
                              ) : null}
                            </span>
                          </li>
                        )
                      }
                      const isTask = it.kind === 'task'
                      const title = isTask ? it.task.title : it.event.name
                      const completed = isTask ? it.task.completed : false
                      // A multi-day event is placed in each day it spans; on days
                      // after its start day this is a "continuation" row — show no
                      // start time (the stale start time belongs to day 1) and an
                      // "Ongoing" chip so the timeless row reads clearly.
                      const isContinuation =
                        !isTask &&
                        it.event.startAt != null &&
                        localYmd(it.event.startAt) !== g.ymd
                      // Show a task's time only when one was actually set, else a
                      // date-only due reads as a bogus midnight hour. dueDate is a
                      // genuine instant (BFF-resolved), so fmtTime renders it local.
                      // Events always carry a real instant.
                      const timeLabel = isTask
                        ? hasTimeOfDay(it.task.dueDate)
                          ? fmtTime(it.task.dueDate)
                          : ''
                        : it.event.allDay || isContinuation
                          ? ''
                          : fmtTime(it.event.startAt)
                      const loc = isTask ? null : it.event.locationLabel
                      const repeats = isTask && it.task.seriesId != null
                      const ticket = !isTask && it.event.ticketCount > 0
                      const priority = isTask ? it.task.priority : null
                      const key = isTask ? `task:${it.task.id}` : `event:${it.event.id}@${g.ymd}`
                      return (
                        <li
                          key={key}
                          className="pl-row"
                          {...openProps(() =>
                            it.kind === 'task'
                              ? setSelected({ kind: 'task', task: it.task })
                              : setSelected({ kind: 'event', event: it.event }),
                          )}
                          style={{
                            gridTemplateColumns: isTask ? '20px 1fr auto' : '1fr auto',
                            alignItems: 'center',
                            cursor: 'pointer',
                          }}
                        >
                          {isTask && (
                            <span onClick={stop} style={{ display: 'flex' }}>
                              <Check
                                done={completed}
                                onClick={() => toggleTask(it.task.listId, it.task.id, completed)}
                              />
                            </span>
                          )}
                          <span
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 5,
                              minWidth: 0,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 13.5,
                                color: completed ? 'var(--ink-mute)' : 'var(--ink)',
                                textDecoration: completed ? 'line-through' : 'none',
                              }}
                            >
                              {title}
                            </span>
                            <span
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 7,
                                flexWrap: 'wrap',
                              }}
                            >
                              <span
                                className="eyebrow"
                                style={{ color: isTask ? 'var(--ink-mute)' : 'var(--acid)' }}
                              >
                                {it.kind}
                              </span>
                              {isContinuation && <span className="pl-chip">Ongoing</span>}
                              {loc && (
                                <span
                                  className="meta"
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                >
                                  <Icon name="pin" size={10} />
                                  {loc}
                                </span>
                              )}
                              {repeats && it.kind === 'task' && it.task.seriesId && (
                                <SeriesChip
                                  seriesId={it.task.seriesId}
                                  surface={it.task.listId === choresListId ? 'chores' : 'tasks'}
                                  lookup={seriesLookup}
                                  onEdit={(r) =>
                                    setSelected({
                                      kind: 'series',
                                      series: r.series,
                                      surface: r.surface,
                                    })
                                  }
                                />
                              )}
                              {ticket && <span className="pl-chip accent">Ticket</span>}
                            </span>
                          </span>
                          <span
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 9,
                              alignSelf: 'flex-start',
                            }}
                          >
                            {timeLabel && (
                              <span
                                className="mono"
                                style={{ fontSize: 12, color: 'var(--ink-dim)' }}
                              >
                                {timeLabel}
                              </span>
                            )}
                            <PriTag p={priority} />
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))
            )}
          </div>

          <aside className="pl-card up-backlog" style={{ padding: 15 }}>
            <EyeRow>No date · Backlog</EyeRow>
            {data.undated.length === 0 ? (
              <p className="meta" style={{ color: 'var(--ink-mute)' }}>
                Backlog is empty.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
                {data.undated.map((it) => {
                  if (it.kind === 'eventDay') return null
                  if (it.kind === 'event') {
                    const ev = it.event
                    return (
                      <li
                        key={`event:${ev.id}`}
                        {...openProps(() => setSelected({ kind: 'event', event: ev }))}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ fontSize: 13, color: 'var(--ink-dim)' }}>{ev.name}</span>
                      </li>
                    )
                  }
                  const tk = it.task
                  return (
                    <li
                      key={`task:${tk.id}`}
                      {...openProps(() => setSelected({ kind: 'task', task: tk }))}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
                    >
                      <span onClick={stop} style={{ display: 'flex' }}>
                        <Check
                          done={tk.completed}
                          sz={18}
                          onClick={() => toggleTask(tk.listId, tk.id, tk.completed)}
                        />
                      </span>
                      <span
                        style={{
                          fontSize: 13,
                          color: tk.completed ? 'var(--ink-mute)' : 'var(--ink-dim)',
                          textDecoration: tk.completed ? 'line-through' : 'none',
                        }}
                      >
                        {tk.title}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </aside>
        </div>
      ) : null}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={
          selected?.kind === 'task'
            ? 'Task'
            : selected?.kind === 'series'
              ? 'Edit series'
              : selected?.kind === 'holiday'
                ? 'Holiday'
                : 'Event'
        }
        mobileSheet
      >
        {selected?.kind === 'task' && (
          <TaskDetail
            task={selected.task}
            onChanged={onChanged}
            onClose={() => setSelected(null)}
          />
        )}
        {selected?.kind === 'event' && (
          <PersonalEventEdit
            event={selected.event}
            onChanged={onChanged}
            onClose={() => setSelected(null)}
          />
        )}
        {selected?.kind === 'eventDay' && <EventDayDetail eventDay={selected.eventDay} />}
        {selected?.kind === 'holiday' && (
          <HolidayDetail
            holiday={selected.holiday}
            onHide={() => {
              onHideHoliday(selected.holiday)
              setSelected(null)
            }}
          />
        )}
        {selected?.kind === 'series' && (
          <SeriesEdit
            series={selected.series}
            surface={selected.surface}
            onChanged={onChanged}
            onClose={() => setSelected(null)}
          />
        )}
      </Drawer>
    </>
  )
}
