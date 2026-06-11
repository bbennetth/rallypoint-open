import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getMyDay,
  setGroupEventPlannerPref,
  setTaskItemCompleted,
  type EventDayDto,
  type MyDay,
  type MyDayEvent,
  type MyDayTask,
} from '../lib/api.js'
import {
  fmtTime,
  localToday,
  normalizeDayMode,
  pickNext,
  progressPct,
  splitMyDay,
  type DayMode,
} from '../lib/planner-helpers.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Drawer } from '@rallypoint/ui'
import { Icon, Ring } from '../ui/icons.js'
import { Check, EventEditPencil, EyeRow, PriTag } from '../ui/bits.js'
import { TaskDetail } from '../ui/TaskDetail.js'
import { PersonalEventEdit } from '../ui/PersonalEventEdit.js'
import { EventDayDetail } from '../ui/EventDayDetail.js'
import { openProps, stopRowOpen as stop } from '../ui/row-open.js'
import { UpcomingView } from './UpcomingPage.js'

// My Day hosts two modes behind a segmented toggle (issue #495): 'today'
// (the classic My Day roll-up) and 'upcoming' (the former Upcoming tab).
// Persisted to ?mode= so /upcoming can redirect here and links survive.
function readModeParam(): DayMode {
  return normalizeDayMode(new URLSearchParams(window.location.search).get('mode'))
}

function writeModeParam(m: DayMode) {
  const url = new URL(window.location.href)
  if (m === 'today') {
    url.searchParams.delete('mode')
    url.searchParams.delete('view') // calendar view param belongs to upcoming mode
  } else {
    url.searchParams.set('mode', m)
  }
  window.history.replaceState(null, '', url.toString())
}

type Selected =
  | { kind: 'task'; task: MyDayTask }
  | { kind: 'event'; event: MyDayEvent }
  | { kind: 'eventDay'; eventDay: EventDayDto }

// My Day surface (slice 8 + Ink redesign). A roll-up of tasks due today and
// personal events starting today, resolved in the browser's local timezone.
// Data lives in Lists/Events via the planner-api BFF; this page owns view
// state, the local date/tz it sends, and optimistic Mark-done toggles.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

function headingLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function MyDayPage() {
  const [data, setData] = useState<MyDay | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [mode, setMode] = useState<DayMode>(readModeParam)

  function switchMode(m: DayMode) {
    // The detail Drawer lives in the today branch; clear the selection so a
    // mode round-trip doesn't re-open a stale drawer.
    setSelected(null)
    setMode(m)
    writeModeParam(m)
  }

  const refresh = useCallback(async () => {
    const { date, tz } = localToday()
    setLoading(true)
    try {
      setData(await getMyDay(date, tz))
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A task/event created via the global FAB (or edited in the slider) shows up
  // here without a manual reload.
  useEffect(() => onCreated('task', () => void refresh()), [refresh])
  useEffect(() => onCreated('event', () => void refresh()), [refresh])

  async function toggle(task: MyDayTask) {
    if (!data || busyId === task.id) return
    const next = !task.completed
    setBusyId(task.id)
    // Optimistic update for both dated and undated task lists.
    setData((d) => {
      if (!d) return d
      const patchList = (list: MyDayTask[]) =>
        list.map((t) => (t.id === task.id ? { ...t, completed: next } : t))
      return {
        ...d,
        tasks: patchList(d.tasks),
        undatedTasks: patchList(d.undatedTasks),
      }
    })
    try {
      await setTaskItemCompleted(task.listId, task.id, next)
    } catch (err) {
      setError(errMessage(err))
      // Roll back optimistic update.
      setData((d) => {
        if (!d) return d
        const rollback = (list: MyDayTask[]) =>
          list.map((t) => (t.id === task.id ? { ...t, completed: task.completed } : t))
        return {
          ...d,
          tasks: rollback(d.tasks),
          undatedTasks: rollback(d.undatedTasks),
        }
      })
    } finally {
      setBusyId(null)
    }
  }

  async function onRemoveEventFromPlanner(eventDay: EventDayDto) {
    if (!data) return
    try {
      await setGroupEventPlannerPref(eventDay.eventId, false)
      setData((d) =>
        d
          ? { ...d, eventDays: d.eventDays.filter((ed) => ed.eventId !== eventDay.eventId) }
          : d,
      )
    } catch (err) {
      setError(errMessage(err))
    }
  }

  const view = useMemo(() => {
    if (!data) return null
    const { allDay, allDayEvents, timeline } = splitMyDay(data.tasks, data.events, data.eventDays)
    const allTasks = [...data.tasks, ...data.undatedTasks]
    const total = allTasks.length
    const done = allTasks.filter((t) => t.completed).length
    const next = pickNext(timeline, Date.now())
    return {
      allDay,
      allDayEvents,
      timeline,
      total,
      done,
      left: total - done,
      pct: progressPct(done, total),
      eventsCount: data.events.length + data.eventDays.length,
      next,
    }
  }, [data])

  return (
    <>
      <div className="pg-head" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>My Day</h1>
          <div className="sub">
            {mode === 'upcoming'
              ? 'Everything on the horizon, soonest first.'
              : (data ? headingLabel(data.date) : 'Today') +
                (view ? (view.total > 0 ? ` · ${view.done} of ${view.total} tasks done` : ' · All clear') : '')}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginLeft: 'auto' }}>
          <div className="seg" role="radiogroup" aria-label="My Day mode" style={{ flexShrink: 0 }}>
            <button
              type="button"
              role="radio"
              className={mode === 'today' ? 'on' : ''}
              onClick={() => switchMode('today')}
              aria-checked={mode === 'today'}
            >
              <Icon name="myday" size={12} />
              Today
            </button>
            <button
              type="button"
              role="radio"
              className={mode === 'upcoming' ? 'on' : ''}
              onClick={() => switchMode('upcoming')}
              aria-checked={mode === 'upcoming'}
            >
              <Icon name="upcoming" size={12} />
              Upcoming
            </button>
          </div>
          {mode === 'today' && view && <Ring pct={view.pct} size={62} />}
        </div>
      </div>

      {mode === 'upcoming' ? (
        <UpcomingView />
      ) : (
        <>
      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {loading && !data ? (
        <p style={{ color: 'var(--ink-dim)', fontSize: 14, margin: 0 }}>Loading…</p>
      ) : view ? (
        <>
          <div className="md-stats">
            <div className="pl-stat">
              <div className="v">{view.left}</div>
              <div className="k">Tasks left</div>
            </div>
            <div className="pl-stat">
              <div className="v">{view.eventsCount}</div>
              <div className="k">Events today</div>
            </div>
            <div className="pl-stat" style={{ borderColor: 'var(--acid)' }}>
              <div className="v" style={{ color: 'var(--acid)' }}>
                {view.next ? fmtTime(view.next.at) : '—'}
              </div>
              <div className="k">{view.next ? `Next · ${view.next.title}` : 'Nothing next'}</div>
            </div>
          </div>

          {(view.allDay.length > 0 || view.allDayEvents.length > 0) && (
            <>
              <EyeRow>All day</EyeRow>
              <div className="md-allday">
                {view.allDay.map((a) => (
                  <div
                    key={a.id}
                    className="pl-row"
                    {...openProps(() => setSelected({ kind: 'task', task: a }))}
                    style={{ gridTemplateColumns: '1fr auto', borderRadius: 0, cursor: 'pointer', opacity: busyId === a.id ? 0.5 : 1 }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                      <PriTag p={a.priority} />
                      <span
                        style={{
                          fontSize: 13,
                          color: a.completed ? 'var(--ink-mute)' : 'var(--ink)',
                          textDecoration: a.completed ? 'line-through' : 'none',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {a.title}
                      </span>
                      {a.shared && (
                        <span className="pl-chip" style={{ flexShrink: 0, borderColor: 'var(--acid-dim)', color: 'var(--acid)' }}>
                          Shared
                        </span>
                      )}
                    </span>
                    <span onClick={stop} style={{ display: 'flex' }}>
                      <Check done={a.completed} onClick={() => toggle(a)} />
                    </span>
                  </div>
                ))}
                {view.allDayEvents.map((d) => (
                  <div
                    key={`eventDay:${d.eventId}@${d.date}`}
                    className="pl-row"
                    {...openProps(() => setSelected({ kind: 'eventDay', eventDay: d }))}
                    style={{ gridTemplateColumns: '1fr auto', borderRadius: 0, cursor: 'pointer' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                      <span className="pl-chip accent">Event</span>
                      <span
                        style={{
                          fontSize: 13,
                          color: 'var(--ink)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {d.name}
                      </span>
                      {d.shared && (
                        <span className="pl-chip" style={{ flexShrink: 0, borderColor: 'var(--acid-dim)', color: 'var(--acid)' }}>
                          Shared
                        </span>
                      )}
                    </span>
                    {d.shared ? (
                      <span onClick={stop} style={{ display: 'flex' }}>
                        <button
                          type="button"
                          className="pl-donebtn"
                          onClick={() => void onRemoveEventFromPlanner(d)}
                          aria-label={`Remove ${d.name} from Planner`}
                          style={{ flexShrink: 0 }}
                        >
                          Remove
                        </button>
                      </span>
                    ) : d.owned ? (
                      <span onClick={stop} style={{ display: 'flex' }}>
                        <EventEditPencil slug={d.slug} />
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}

          <EyeRow>Schedule</EyeRow>
          {view.timeline.length === 0 ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>Nothing scheduled today.</p>
          ) : (
            <div className="pl-timeline">
              {view.timeline.map((e, i) => (
                <div key={e.id} style={{ display: 'contents' }}>
                  <div className="pl-tl-time">{fmtTime(e.at)}</div>
                  <div className="pl-tl-rail" style={{ paddingBottom: i === view.timeline.length - 1 ? 0 : 2 }}>
                    <span className="pl-tl-tick" />
                    <div
                      className={
                        'pl-ev' +
                        (e.kind === 'task' ? ' task' : '') +
                        (e.task?.completed ? ' done' : '')
                      }
                      {...openProps(() => {
                        if (e.kind === 'task' && e.task) setSelected({ kind: 'task', task: e.task })
                        else if (e.kind === 'event' && e.event)
                          setSelected({ kind: 'event', event: e.event })
                        else if (e.kind === 'eventDay' && e.eventDay)
                          setSelected({ kind: 'eventDay', eventDay: e.eventDay })
                      })}
                      style={{ cursor: 'pointer', opacity: e.kind === 'task' && e.task && busyId === e.task.id ? 0.5 : 1 }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        {e.kind === 'task' && <PriTag p={e.task?.priority} />}
                        <span
                          className="t"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            color: e.task?.completed ? 'var(--ink-mute)' : 'var(--ink)',
                            textDecoration: e.task?.completed ? 'line-through' : 'none',
                          }}
                        >
                          {e.title}
                        </span>
                        {e.kind === 'task' && e.task?.shared && (
                          <span className="pl-chip" style={{ flexShrink: 0, borderColor: 'var(--acid-dim)', color: 'var(--acid)' }}>
                            Shared
                          </span>
                        )}
                        {e.kind === 'eventDay' && e.eventDay?.shared && (
                          <span className="pl-chip" style={{ flexShrink: 0, borderColor: 'var(--acid-dim)', color: 'var(--acid)' }}>
                            Shared
                          </span>
                        )}
                        {e.kind === 'task' && e.task ? (
                          <span onClick={stop} style={{ display: 'flex' }}>
                            <Check
                              done={e.task.completed}
                              onClick={() => toggle(e.task!)}
                            />
                          </span>
                        ) : e.kind === 'eventDay' && e.eventDay ? (
                          e.eventDay.shared ? (
                            <span onClick={stop} style={{ display: 'flex' }}>
                              <button
                                type="button"
                                className="pl-donebtn"
                                onClick={() => void onRemoveEventFromPlanner(e.eventDay!)}
                                aria-label={`Remove ${e.eventDay.name} from Planner`}
                                style={{ flexShrink: 0 }}
                              >
                                Remove
                              </button>
                            </span>
                          ) : e.eventDay.owned ? (
                            <span onClick={stop} style={{ display: 'flex' }}>
                              <EventEditPencil slug={e.eventDay.slug} />
                            </span>
                          ) : null
                        ) : (
                          e.event &&
                          e.event.ticketCount > 0 && (
                            <span className="pl-chip accent">
                              <Icon name="events" size={11} />
                              Ticket
                            </span>
                          )
                        )}
                      </div>
                      {e.event?.locationLabel && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5, color: 'var(--ink-dim)' }}>
                          <Icon name="pin" size={11} />
                          <span className="meta">{e.event.locationLabel}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {data.undatedTasks.length > 0 && (
            <>
              <EyeRow>No date</EyeRow>
              <div className="md-allday">
                {data.undatedTasks.map((u) => (
                  <div
                    key={u.id}
                    className="pl-row"
                    {...openProps(() => setSelected({ kind: 'task', task: u }))}
                    style={{ gridTemplateColumns: '1fr auto', borderRadius: 0, cursor: 'pointer', opacity: busyId === u.id ? 0.5 : 1 }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                      <PriTag p={u.priority} />
                      <span
                        style={{
                          fontSize: 13,
                          color: u.completed ? 'var(--ink-mute)' : 'var(--ink)',
                          textDecoration: u.completed ? 'line-through' : 'none',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {u.title}
                      </span>
                      {u.shared && (
                        <span className="pl-chip" style={{ flexShrink: 0, borderColor: 'var(--acid-dim)', color: 'var(--acid)' }}>
                          Shared
                        </span>
                      )}
                    </span>
                    <span onClick={stop} style={{ display: 'flex' }}>
                      <Check done={u.completed} onClick={() => toggle(u)} />
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : null}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.kind === 'task' ? 'Task' : 'Event'}
        mobileSheet
      >
        {selected?.kind === 'task' && (
          <TaskDetail
            task={selected.task}
            onChanged={() => void refresh()}
            onClose={() => setSelected(null)}
          />
        )}
        {selected?.kind === 'event' && (
          <PersonalEventEdit
            event={selected.event}
            onChanged={() => void refresh()}
            onClose={() => setSelected(null)}
          />
        )}
        {selected?.kind === 'eventDay' && <EventDayDetail eventDay={selected.eventDay} />}
      </Drawer>
        </>
      )}
    </>
  )
}
