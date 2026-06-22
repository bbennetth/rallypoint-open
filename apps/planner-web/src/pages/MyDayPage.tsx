import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getMyDay,
  getRecurring,
  getSettings,
  getUpcoming,
  listChoreSeries,
  listHolidays,
  setGroupEventPlannerPref,
  setTaskItemCompleted,
  updateSettings,
  type EventDayDto,
  type HolidayDto,
  type MyDay,
  type MyDayEvent,
  type MyDayTask,
  type TaskSeriesDto,
  type Upcoming,
} from '../lib/api.js'
import {
  fmtTime,
  localToday,
  localYmd,
  mydayStatusLabel,
  pickNext,
  splitMyDay,
} from '../lib/planner-helpers.js'
import { hiddenHolidays, holidaysEnabled, holidaysOnDay } from '../lib/holidays-helpers.js'
import {
  buildSeriesLookup,
  pickChoresListId,
  type ResolvedSeries,
  type SeriesSurface,
} from '../lib/series-lookup.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Drawer } from '@rallypoint/ui'
import { Icon } from '../ui/icons.js'
import { Check, EventEditPencil, EyeRow, PriTag } from '../ui/bits.js'
import { TaskDetail } from '../ui/TaskDetail.js'
import { SeriesEdit } from '../ui/SeriesEdit.js'
import { SeriesChip } from '../ui/SeriesChip.js'
import { WeatherStrip } from '../ui/WeatherStrip.js'
import { SkeletonBlock, SkeletonRows } from '../ui/Skeleton.js'
import { PersonalEventEdit } from '../ui/PersonalEventEdit.js'
import { EventDayDetail } from '../ui/EventDayDetail.js'
import { HolidayDetail } from '../ui/EventDetail.js'
import { openProps, stopRowOpen as stop } from '../ui/row-open.js'
import { UpcomingFeed } from './UpcomingFeed.js'
import { CalendarBody } from './CalendarBody.js'
import { MY_DAY_VIEW_KEY, parseMyDayView, type MyDayView } from '../lib/my-day-view.js'

type Selected =
  | { kind: 'task'; task: MyDayTask }
  | { kind: 'event'; event: MyDayEvent }
  | { kind: 'eventDay'; eventDay: EventDayDto }
  | { kind: 'holiday'; holiday: HolidayDto }
  | { kind: 'series'; series: TaskSeriesDto; surface: SeriesSurface }

// My Day surface (slice 8 + Ink redesign). A single scrolling agenda: today's
// roll-up (tasks due today + personal events starting today, resolved in the
// browser's local timezone) at the top, then a "Coming up" feed of everything
// on the horizon below it (the former Upcoming tab, folded in here without a
// mode toggle — issue #495 shipped the toggle, this removes it). The page owns
// the my-day + upcoming + recurring fetch and passes the forward-looking data
// down to <UpcomingFeed>. Data lives in Lists/Events via the planner-api BFF.

// How far ahead the agenda lists holidays (mirrors the Events page horizon).
const HOLIDAY_LOOKAHEAD_DAYS = 90

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
  const [upcoming, setUpcoming] = useState<Upcoming | null>(null)
  // US holidays for the forward window — the FULL fetched list (master-toggle
  // gated only). The hidden-ids filter is applied as a derived memo below, so a
  // Hide only updates the setting (no refetch) and drops the holiday from both
  // surfaces at once. plannerSettings carries the holiday prefs (master toggle +
  // hidden-ids).
  const [holidays, setHolidays] = useState<HolidayDto[]>([])
  const [plannerSettings, setPlannerSettings] = useState<Record<string, unknown>>({})
  // seriesId → {series, surface} for badging/editing recurring rows. Task
  // series come from the /recurring roll-up; chore series (excluded there) are
  // fetched separately when a chore occurrence is visible.
  const [seriesLookup, setSeriesLookup] = useState<Map<string, ResolvedSeries>>(new Map())
  // The chores list id (when any chore occurrence is on screen), used to label a
  // recurring row's badge "Chore" vs "Repeats" without depending on the lookup.
  const [choresListId, setChoresListId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Selected | null>(null)
  // The active lens: scrolling agenda (default) or the folded-in month/week
  // calendar grid. Persisted per-user in the 'planner' settings namespace.
  const [dayView, setDayViewState] = useState<MyDayView>('agenda')

  const today = useMemo(() => localToday().date, [])

  // Restore the persisted lens on mount (default agenda) + capture the planner
  // settings blob (holiday prefs ride along for the holiday fetch below).
  useEffect(() => {
    let cancelled = false
    void getSettings('planner')
      .then((s) => {
        if (cancelled) return
        setDayViewState(parseMyDayView(s[MY_DAY_VIEW_KEY]))
        setPlannerSettings(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Holidays for the forward window [today, today + lookahead]. The agenda is the
  // only lens that consumes them (the calendar lens fetches its own, windowed to
  // the visible month/week), so skip the fetch entirely in calendar views.
  //
  // Gate on the derived boolean (not the whole plannerSettings object) so hiding
  // a holiday — which mutates plannerSettings.hiddenHolidays — does NOT re-fire
  // this fetch; the hidden filter is applied by the visibleHolidays memo below.
  const holidaysOn = holidaysEnabled(plannerSettings)
  useEffect(() => {
    if (dayView !== 'agenda' || !holidaysOn) {
      setHolidays([])
      return
    }
    let cancelled = false
    const to = new Date(`${today}T00:00:00`)
    to.setDate(to.getDate() + HOLIDAY_LOOKAHEAD_DAYS)
    void listHolidays(today, localYmd(to.toISOString()))
      .then((rows) => {
        if (!cancelled) setHolidays(rows)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dayView, today, holidaysOn])

  // The hidden-ids filter, applied as a derived view of the fetched list. Hiding
  // a holiday appends its id to plannerSettings.hiddenHolidays, which re-runs
  // this memo and removes it from both the roll-up band and the Coming up feed.
  const visibleHolidays = useMemo(() => {
    const hidden = hiddenHolidays(plannerSettings)
    return hidden.length > 0 ? holidays.filter((h) => !hidden.includes(h.id)) : holidays
  }, [holidays, plannerSettings])

  function changeDayView(next: MyDayView) {
    setDayViewState(next)
    void updateSettings('planner', { [MY_DAY_VIEW_KEY]: next })
  }

  // The Upcoming tab is gone; scrub any stale ?mode= / ?view= a bookmarked or
  // redirected link may carry so the URL reflects the single-agenda view.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has('mode') || url.searchParams.has('view')) {
      url.searchParams.delete('mode')
      url.searchParams.delete('view')
      window.history.replaceState(null, '', url.toString())
    }
  }, [])

  const refresh = useCallback(async () => {
    const { date, tz } = localToday()
    setLoading(true)
    // One parallel fetch feeds the whole agenda. My Day is the critical slice —
    // its failure surfaces an error. Upcoming + Recurring are best-effort: if
    // either fails the today roll-up still renders, the feed just stays empty.
    const [md, up, rec] = await Promise.allSettled([
      getMyDay(date, tz),
      getUpcoming(date, tz),
      getRecurring(date, tz),
    ])
    const mdVal = md.status === 'fulfilled' ? md.value : null
    const upVal = up.status === 'fulfilled' ? up.value : null
    const recVal = rec.status === 'fulfilled' ? rec.value : null
    if (mdVal) {
      setData(mdVal)
      setError(null)
    } else {
      setError(errMessage(md.reason))
    }
    setUpcoming(upVal)

    // Build the recurring-series lookup. Task series come from /recurring; a
    // chore occurrence (seriesId not among the task series) reveals the chores
    // list id, so we fetch chore series only when one is actually on screen —
    // avoids auto-provisioning a chores list for users who have none. This
    // distinction needs the task-series baseline, so skip it entirely when
    // /recurring failed (otherwise a task row would be misread as a chore).
    const taskSeries: TaskSeriesDto[] = recVal?.recurring ?? []
    const taskIds = new Set(taskSeries.map((s) => s.id))
    const rows: { seriesId: string | null; listId: string }[] = []
    if (mdVal) rows.push(...mdVal.tasks, ...mdVal.undatedTasks)
    if (upVal) {
      for (const it of [...upVal.dated, ...upVal.undated]) {
        if (it.kind === 'task') rows.push(it.task)
      }
    }
    const choresList = recVal ? pickChoresListId(rows, taskIds) : null
    let choreSeries: TaskSeriesDto[] = []
    if (choresList) {
      try {
        choreSeries = await listChoreSeries(choresList)
      } catch {
        // Best-effort: chore rows just keep a non-clickable badge.
      }
    }
    setChoresListId(choresList)
    setSeriesLookup(buildSeriesLookup(taskSeries, choreSeries))
    setLoading(false)
  }, [])

  useEffect(() => {
    if (dayView === 'agenda') void refresh()
  }, [refresh, dayView])

  // A task/event created via the global FAB (or edited in the slider) shows up
  // here without a manual reload.
  useEffect(() => onCreated('task', () => void refresh()), [refresh])
  useEffect(() => onCreated('event', () => void refresh()), [refresh])
  useEffect(() => onCreated('chore', () => void refresh()), [refresh])

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
        d ? { ...d, eventDays: d.eventDays.filter((ed) => ed.eventId !== eventDay.eventId) } : d,
      )
    } catch (err) {
      setError(errMessage(err))
    }
  }

  // Holidays whose observed day is today → shown in the roll-up's all-day band.
  const todayHolidays = useMemo(
    () => holidaysOnDay(visibleHolidays, today),
    [visibleHolidays, today],
  )

  // Hide a holiday from every Planner surface: append its id to the hidden-ids
  // setting (optimistic). The visibleHolidays memo re-derives, dropping it from
  // both the roll-up band and the Coming up feed — no refetch needed.
  function hideHoliday(h: HolidayDto) {
    setPlannerSettings((s) => {
      const hidden = [...hiddenHolidays(s), h.id]
      void updateSettings('planner', { hiddenHolidays: hidden })
      return { ...s, hiddenHolidays: hidden }
    })
    setSelected((cur) => (cur?.kind === 'holiday' && cur.holiday.id === h.id ? null : cur))
  }

  const view = useMemo(() => {
    if (!data) return null
    const { allDay, allDayEvents, allDayPersonalEvents, timeline } = splitMyDay(
      data.tasks,
      data.events,
      data.eventDays,
      today,
    )
    const allTasks = [...data.tasks, ...data.undatedTasks]
    const total = allTasks.length
    const done = allTasks.filter((t) => t.completed).length
    const next = pickNext(timeline, Date.now())
    return {
      allDay,
      allDayEvents,
      allDayPersonalEvents,
      timeline,
      total,
      done,
      left: total - done,
      eventsCount: data.events.length + data.eventDays.length,
      next,
    }
  }, [data, today])

  return (
    <>
      <div className="pg-head" style={{ marginBottom: 10 }}>
        <h1>My Day</h1>
      </div>

      {/* View switcher lives on its own toolbar row (not in the title row) so
          it never moves between Agenda/Month/Week. The agenda status line is
          appended on the right; in calendar views the row is just the seg, but
          its height is unchanged (the seg is the tallest element either way),
          so toggling views causes no layout shift. */}
      <div className="md-toolbar">
        <div className="seg" role="group" aria-label="My Day view">
          <button
            type="button"
            className={dayView === 'agenda' ? 'on' : ''}
            aria-pressed={dayView === 'agenda'}
            onClick={() => changeDayView('agenda')}
          >
            Agenda
          </button>
          <button
            type="button"
            className={dayView === 'month' ? 'on' : ''}
            aria-pressed={dayView === 'month'}
            onClick={() => changeDayView('month')}
          >
            Month
          </button>
          <button
            type="button"
            className={dayView === 'week' ? 'on' : ''}
            aria-pressed={dayView === 'week'}
            onClick={() => changeDayView('week')}
          >
            Week
          </button>
        </div>
        {dayView === 'agenda' && (
          <span className="md-status">
            {mydayStatusLabel(
              data ? headingLabel(data.date) : 'Today',
              view ? view.total : null,
              view ? view.done : 0,
            )}
          </span>
        )}
      </div>

      {dayView !== 'agenda' ? (
        <CalendarBody view={dayView} />
      ) : (
        <>
          {error && (
            <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
              {error}
            </p>
          )}

          {loading && !data ? (
            <div role="status" aria-busy="true" aria-label="Loading your day">
              {/* Mirror the agenda layout (weather card + stat row + a few
                  schedule rows) so the real content swaps in without a jump. */}
              <SkeletonBlock height={56} style={{ marginBottom: 14 }} />
              <div className="md-stats">
                <SkeletonBlock height={62} />
                <SkeletonBlock height={62} />
                <SkeletonBlock height={62} />
              </div>
              <SkeletonRows count={3} height={48} bare />
            </div>
          ) : view ? (
            <>
              <WeatherStrip />
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
                  <div className="k">
                    {view.next ? `Next · ${view.next.title}` : 'Nothing next'}
                  </div>
                </div>
              </div>

              {(view.allDay.length > 0 ||
                view.allDayEvents.length > 0 ||
                view.allDayPersonalEvents.length > 0 ||
                todayHolidays.length > 0) && (
                <>
                  <EyeRow>All day</EyeRow>
                  <div className="md-allday">
                    {view.allDay.map((a) => (
                      <div
                        key={a.id}
                        className="pl-row"
                        {...openProps(() => setSelected({ kind: 'task', task: a }))}
                        style={{
                          gridTemplateColumns: '1fr auto',
                          borderRadius: 0,
                          cursor: 'pointer',
                          opacity: busyId === a.id ? 0.5 : 1,
                        }}
                      >
                        <span
                          style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}
                        >
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
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {a.seriesId && (
                            <SeriesChip
                              seriesId={a.seriesId}
                              surface={a.listId === choresListId ? 'chores' : 'tasks'}
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
                          <span onClick={stop} style={{ display: 'flex' }}>
                            <Check done={a.completed} onClick={() => toggle(a)} />
                          </span>
                        </span>
                      </div>
                    ))}
                    {view.allDayEvents.map((d) => (
                      <div
                        key={`eventDay:${d.eventId}@${d.date}`}
                        className="pl-row"
                        {...openProps(() => setSelected({ kind: 'eventDay', eventDay: d }))}
                        style={{
                          gridTemplateColumns: '1fr auto',
                          borderRadius: 0,
                          cursor: 'pointer',
                        }}
                      >
                        <span
                          style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}
                        >
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
                            <span
                              className="pl-chip"
                              style={{
                                flexShrink: 0,
                                borderColor: 'var(--acid-dim)',
                                color: 'var(--acid)',
                              }}
                            >
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
                    {view.allDayPersonalEvents.map((e) => {
                      // Continuation = a multi-day event that started before today
                      // (its day-1 time is moot today); else a genuine all-day event.
                      const ongoing = e.startAt != null && localYmd(e.startAt) < today
                      return (
                        <div
                          key={`event:${e.id}`}
                          className="pl-row"
                          {...openProps(() => setSelected({ kind: 'event', event: e }))}
                          style={{
                            gridTemplateColumns: '1fr auto',
                            borderRadius: 0,
                            cursor: 'pointer',
                          }}
                        >
                          <span
                            style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}
                          >
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
                              {e.name}
                            </span>
                            <span className="pl-chip" style={{ flexShrink: 0 }}>
                              {ongoing ? 'Ongoing' : 'All day'}
                            </span>
                          </span>
                          {e.ticketCount > 0 && (
                            <span className="pl-chip accent" style={{ flexShrink: 0 }}>
                              <Icon name="events" size={11} />
                              Ticket
                            </span>
                          )}
                        </div>
                      )
                    })}
                    {todayHolidays.map((h) => (
                      <div
                        key={`holiday:${h.id}`}
                        className="pl-row"
                        {...openProps(() => setSelected({ kind: 'holiday', holiday: h }))}
                        style={{
                          gridTemplateColumns: '1fr auto',
                          borderRadius: 0,
                          cursor: 'pointer',
                        }}
                      >
                        <span
                          style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}
                        >
                          <span className="pl-chip">Holiday</span>
                          <span
                            style={{
                              fontSize: 13,
                              color: 'var(--ink)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {h.name}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <EyeRow>Schedule</EyeRow>
              {view.timeline.length === 0 ? (
                <p className="meta" style={{ color: 'var(--ink-mute)' }}>
                  Nothing scheduled today.
                </p>
              ) : (
                <div className="pl-timeline">
                  {view.timeline.map((e, i) => (
                    <div key={e.id} style={{ display: 'contents' }}>
                      <div className="pl-tl-time">{fmtTime(e.at)}</div>
                      <div
                        className="pl-tl-rail"
                        style={{ paddingBottom: i === view.timeline.length - 1 ? 0 : 2 }}
                      >
                        <span className="pl-tl-tick" />
                        <div
                          className={
                            'pl-ev' +
                            (e.kind === 'task' ? ' task' : '') +
                            (e.task?.completed ? ' done' : '')
                          }
                          {...openProps(() => {
                            if (e.kind === 'task' && e.task)
                              setSelected({ kind: 'task', task: e.task })
                            else if (e.kind === 'event' && e.event)
                              setSelected({ kind: 'event', event: e.event })
                            else if (e.kind === 'eventDay' && e.eventDay)
                              setSelected({ kind: 'eventDay', eventDay: e.eventDay })
                          })}
                          style={{
                            cursor: 'pointer',
                            opacity: e.kind === 'task' && e.task && busyId === e.task.id ? 0.5 : 1,
                          }}
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
                            {e.kind === 'eventDay' && e.eventDay?.shared && (
                              <span
                                className="pl-chip"
                                style={{
                                  flexShrink: 0,
                                  borderColor: 'var(--acid-dim)',
                                  color: 'var(--acid)',
                                }}
                              >
                                Shared
                              </span>
                            )}
                            {e.kind === 'task' && e.task ? (
                              <>
                                {e.task.seriesId && (
                                  <SeriesChip
                                    seriesId={e.task.seriesId}
                                    surface={e.task.listId === choresListId ? 'chores' : 'tasks'}
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
                                <span onClick={stop} style={{ display: 'flex' }}>
                                  <Check done={e.task.completed} onClick={() => toggle(e.task!)} />
                                </span>
                              </>
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
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                marginTop: 5,
                                color: 'var(--ink-dim)',
                              }}
                            >
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
                        style={{
                          gridTemplateColumns: '1fr auto',
                          borderRadius: 0,
                          cursor: 'pointer',
                          opacity: busyId === u.id ? 0.5 : 1,
                        }}
                      >
                        <span
                          style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}
                        >
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
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {u.seriesId && (
                            <SeriesChip
                              seriesId={u.seriesId}
                              surface={u.listId === choresListId ? 'chores' : 'tasks'}
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
                          <span onClick={stop} style={{ display: 'flex' }}>
                            <Check done={u.completed} onClick={() => toggle(u)} />
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {upcoming && (
                <div style={{ marginTop: 14 }}>
                  <EyeRow>Coming up</EyeRow>
                  <UpcomingFeed
                    data={upcoming}
                    holidays={visibleHolidays}
                    seriesLookup={seriesLookup}
                    choresListId={choresListId}
                    todayYmd={today}
                    onHideHoliday={hideHoliday}
                    onChanged={() => void refresh()}
                  />
                </div>
              )}
            </>
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
            {selected?.kind === 'holiday' && (
              <HolidayDetail
                holiday={selected.holiday}
                onHide={() => hideHoliday(selected.holiday)}
              />
            )}
            {selected?.kind === 'series' && (
              <SeriesEdit
                series={selected.series}
                surface={selected.surface}
                onChanged={() => void refresh()}
                onClose={() => setSelected(null)}
              />
            )}
          </Drawer>
        </>
      )}
    </>
  )
}
