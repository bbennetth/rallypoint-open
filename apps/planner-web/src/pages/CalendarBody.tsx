import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getSettings,
  getUpcoming,
  listHolidays,
  listPersonalEvents,
  setTaskItemCompleted,
  updateSettings,
  type EventDayDto,
  type HolidayDto,
  type MyDayTask,
  type PersonalEventDto,
  type Upcoming,
  type UpcomingItem,
} from '../lib/api.js'
import { groupUpcomingByDay, localToday } from '../lib/planner-helpers.js'
import {
  personalEventsToGroups,
  resolveCalendarDetail,
  type CalendarDetail,
} from '../lib/events-calendar-helpers.js'
import { hiddenHolidays, holidaysEnabled, holidaysToGroups } from '../lib/holidays-helpers.js'
import {
  calendarWindow,
  mergeCalendarGroups,
  type CalendarView,
} from '../lib/calendar-merge-helpers.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Drawer } from '@rallypoint/ui'
import { Check, EyeRow } from '../ui/bits.js'
import { SkeletonBlock } from '../ui/Skeleton.js'
import { MonthGrid, WeekStrip } from '../ui/CalendarView.js'
import { EventDetail, HolidayDetail } from '../ui/EventDetail.js'
import { EventDayDetail } from '../ui/EventDayDetail.js'
import { PersonalEventEdit } from '../ui/PersonalEventEdit.js'
import { TaskDetail } from '../ui/TaskDetail.js'
import { ACCEPT_ATTR, useEventTickets } from '../ui/useEventTickets.js'
import { openProps, stopRowOpen as stop } from '../ui/row-open.js'

// Calendar body — the month/week grid lens of My Day. The standalone Calendar
// page was folded into My Day behind the Agenda·Month·Week toggle; the parent
// owns the lens choice and passes `view`. It aggregates everything the planner
// knows onto the shared MonthGrid/WeekStrip: tasks + group event-days
// (forward-looking, from the upcoming BFF), personal events (full history), and
// US holidays (windowed to the visible range). Clicking a chip opens the item's
// detail drawer; undated tasks/events live in the Backlog aside.
//
// Forward-only note: getUpcoming is open-ended forward, so past-due tasks and
// past group event-days don't appear here (they surface on the agenda). Personal
// events keep their full history. A single getUpcoming(today) covers every
// future month, so only the holiday fetch follows calendar navigation.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

// What a calendar chip click resolves to. Tasks / event-days have no Events-tab
// detail resolver, so they're added on top of the shared event/holiday union.
type CalendarSelected =
  | { kind: 'task'; task: MyDayTask }
  | { kind: 'eventDay'; eventDay: EventDayDto }
  | CalendarDetail

export function CalendarBody({ view }: { view: CalendarView }) {
  const todayYmd = useMemo(() => localToday().date, [])

  // Calendar navigation state, initialised once from today.
  const [calYear, setCalYear] = useState(() => Number(todayYmd.slice(0, 4)))
  const [calMonth, setCalMonth] = useState(() => Number(todayYmd.slice(5, 7)))
  const [weekAnchor, setWeekAnchor] = useState(() => todayYmd)

  // Data sources.
  const [upcoming, setUpcoming] = useState<Upcoming | null>(null)
  const [events, setEvents] = useState<PersonalEventDto[]>([])
  const [holidays, setHolidays] = useState<HolidayDto[]>([])
  const [plannerSettings, setPlannerSettings] = useState<Record<string, unknown>>({})

  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Drawer selection + the event-edit sheet opened from EventDetail's Edit.
  const [selected, setSelected] = useState<CalendarSelected | null>(null)
  const [editing, setEditing] = useState<PersonalEventDto | null>(null)

  // Ticket machinery for the event detail drawer — pointed at the selected event.
  const [activeEventId, setActiveEventId] = useState<string | null>(null)
  const {
    tickets,
    loadingTickets,
    uploading,
    fileInputRef,
    onPickFile,
    onDownload,
    triggerAttach,
  } = useEventTickets(activeEventId, setError)

  // One forward-looking fetch feeds every future month; listPersonalEvents gives
  // full event history. Both best-effort: a personal-events hiccup still renders
  // the upcoming-derived chips.
  const refresh = useCallback(async () => {
    const { date, tz } = localToday()
    const [up, ev] = await Promise.allSettled([getUpcoming(date, tz), listPersonalEvents()])
    if (up.status === 'fulfilled') {
      setUpcoming(up.value)
      setError(null)
    } else {
      setError(errMessage(up.reason))
    }
    setEvents(ev.status === 'fulfilled' ? ev.value : [])
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Items created via the global FAB show up without a manual reload.
  useEffect(() => onCreated('task', () => void refresh()), [refresh])
  useEffect(() => onCreated('event', () => void refresh()), [refresh])
  useEffect(() => onCreated('chore', () => void refresh()), [refresh])

  // Load planner holiday prefs on mount.
  useEffect(() => {
    let cancelled = false
    void getSettings('planner')
      .then((s) => {
        if (!cancelled) setPlannerSettings(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Holidays are fetched for exactly the days the calendar shows.
  const holidayWindow = useMemo(
    () => calendarWindow(view, calYear, calMonth, weekAnchor),
    [view, calYear, calMonth, weekAnchor],
  )

  useEffect(() => {
    if (!holidaysEnabled(plannerSettings)) {
      setHolidays([])
      return
    }
    let cancelled = false
    void listHolidays(holidayWindow.from, holidayWindow.to)
      .then((rows) => {
        if (cancelled) return
        const hidden = hiddenHolidays(plannerSettings)
        setHolidays(hidden.length > 0 ? rows.filter((h) => !hidden.includes(h.id)) : rows)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [holidayWindow, plannerSettings])

  // ── Group assembly ────────────────────────────────────────────────
  // Tasks + group event-days come from the forward-looking upcoming feed;
  // personal events come from listPersonalEvents (full history). We drop personal
  // events from the upcoming groups so an event present in both isn't chipped twice.
  const upcomingGroups = useMemo(() => {
    if (!upcoming) return []
    return groupUpcomingByDay(
      upcoming.dated.filter((it) => it.kind !== 'event'),
      todayYmd,
    )
  }, [upcoming, todayYmd])

  const eventGroups = useMemo(() => personalEventsToGroups(events, todayYmd), [events, todayYmd])

  const calGroups = useMemo(
    () => mergeCalendarGroups(upcomingGroups, eventGroups, holidaysToGroups(holidays, todayYmd)),
    [upcomingGroups, eventGroups, holidays, todayYmd],
  )

  // Undated tasks + personal events (no date) for the Backlog aside.
  const backlog = useMemo(
    () => upcoming?.undated.filter((it) => it.kind === 'task' || it.kind === 'event') ?? [],
    [upcoming],
  )

  // ── Interactions ──────────────────────────────────────────────────
  function onItemClick(item: UpcomingItem) {
    if (item.kind === 'task') {
      setActiveEventId(null)
      setSelected({ kind: 'task', task: item.task })
      return
    }
    if (item.kind === 'eventDay') {
      setActiveEventId(null)
      setSelected({ kind: 'eventDay', eventDay: item.eventDay })
      return
    }
    const detail = resolveCalendarDetail(item, events)
    if (!detail) return
    setActiveEventId(detail.kind === 'event' ? detail.event.id : null)
    setSelected(detail)
  }

  // Day-cell clicks are a no-op: chips open details directly.
  function onDayClick(_ymd: string) {}

  function patchTask(id: string, completed: boolean) {
    setUpcoming((u) => {
      if (!u) return u
      const map = (items: UpcomingItem[]) =>
        items.map((it) =>
          it.kind === 'task' && it.task.id === id ? { ...it, task: { ...it.task, completed } } : it,
        )
      return { ...u, dated: map(u.dated), undated: map(u.undated) }
    })
  }

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

  function hideHoliday(h: HolidayDto) {
    setPlannerSettings((s) => {
      const hidden = [...hiddenHolidays(s), h.id]
      void updateSettings('planner', { hiddenHolidays: hidden })
      return { ...s, hiddenHolidays: hidden }
    })
    setHolidays((prev) => prev.filter((x) => x.id !== h.id))
    setSelected((cur) => (cur?.kind === 'holiday' && cur.holiday.id === h.id ? null : cur))
  }

  const drawerTitle =
    selected?.kind === 'task' ? 'Task' : selected?.kind === 'holiday' ? 'Holiday' : 'Event'

  return (
    <>
      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {loading && !upcoming ? (
        <div className="up-cal-wrap" role="status" aria-busy="true" aria-label="Loading calendar">
          <SkeletonBlock height={360} />
          <SkeletonBlock height={120} />
        </div>
      ) : (
        <div className="up-cal-wrap">
          {view === 'month' ? (
            <MonthGrid
              groups={calGroups}
              year={calYear}
              month={calMonth}
              todayYmd={todayYmd}
              onMonthChange={(y, m) => {
                setCalYear(y)
                setCalMonth(m)
              }}
              onDayClick={onDayClick}
              onItemClick={onItemClick}
            />
          ) : (
            <WeekStrip
              groups={calGroups}
              anchorYmd={weekAnchor}
              todayYmd={todayYmd}
              onWeekChange={setWeekAnchor}
              onDayClick={onDayClick}
              onItemClick={onItemClick}
            />
          )}

          <aside className="pl-card up-backlog up-cal-backlog" style={{ padding: 15 }}>
            <EyeRow>No date · Backlog</EyeRow>
            {backlog.length === 0 ? (
              <p className="meta" style={{ color: 'var(--ink-mute)' }}>
                Backlog is empty.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
                {backlog.map((it) => {
                  if (it.kind === 'event') {
                    const ev = it.event
                    return (
                      <li
                        key={`event:${ev.id}`}
                        {...openProps(() => onItemClick(it))}
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
                  if (it.kind !== 'task') return null
                  const tk = it.task
                  return (
                    <li
                      key={`task:${tk.id}`}
                      {...openProps(() => onItemClick(it))}
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
      )}

      {/* Hidden ticket file picker — top-level so EventDetail can trigger it. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        onChange={(e) => void onPickFile(e)}
        style={{ display: 'none' }}
        aria-label="Ticket file"
      />

      {/* Chip detail drawer */}
      <Drawer
        open={selected !== null}
        onClose={() => {
          setSelected(null)
          setActiveEventId(null)
        }}
        title={drawerTitle}
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
          <EventDetail
            event={selected.event}
            tickets={tickets}
            loadingTickets={loadingTickets}
            uploading={uploading}
            onAttach={triggerAttach}
            onDownload={(t) => onDownload(t)}
            onEdit={() => {
              setEditing(selected.event)
              setSelected(null)
            }}
          />
        )}
        {selected?.kind === 'eventDay' && <EventDayDetail eventDay={selected.eventDay} />}
        {selected?.kind === 'holiday' && (
          <HolidayDetail holiday={selected.holiday} onHide={() => hideHoliday(selected.holiday)} />
        )}
      </Drawer>

      {/* Event edit sheet (opened from EventDetail's Edit) */}
      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit event"
        mobileSheet
      >
        {editing && (
          <PersonalEventEdit
            event={editing}
            onChanged={() => void refresh()}
            onClose={() => setEditing(null)}
          />
        )}
      </Drawer>
    </>
  )
}
