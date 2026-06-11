import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getRecurring,
  getUpcoming,
  setGroupEventPlannerPref,
  setTaskItemCompleted,
  type EventDayDto,
  type MyDayEvent,
  type MyDayTask,
  type RecurringResponse,
  type RecurringSeriesDto,
  type Upcoming,
  type UpcomingItem,
} from '../lib/api.js'
import {
  eventDayWindow,
  fmtTime,
  groupUpcomingByDay,
  hasTimeOfDay,
  localToday,
} from '../lib/planner-helpers.js'
import { describeRecurrence, summarizeNext } from '../lib/recurrence-label.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Drawer } from '@rallypoint/ui'
import { Check, EventEditPencil, EyeRow, PriTag } from '../ui/bits.js'
import { Icon } from '../ui/icons.js'
import { TaskDetail } from '../ui/TaskDetail.js'
import { PersonalEventEdit } from '../ui/PersonalEventEdit.js'
import { EventDayDetail } from '../ui/EventDayDetail.js'
import { SeriesEdit } from '../ui/SeriesEdit.js'
import { openProps, stopRowOpen as stop } from '../ui/row-open.js'
import { MonthGrid, WeekStrip } from '../ui/CalendarView.js'

// View modes for the Upcoming page toggle. Persisted to ?view= URL param.
type UpcomingView = 'list' | 'week' | 'month'

function readViewParam(): UpcomingView {
  const p = new URLSearchParams(window.location.search).get('view')
  if (p === 'week' || p === 'month') return p
  return 'list'
}

function writeViewParam(v: UpcomingView) {
  const url = new URL(window.location.href)
  if (v === 'list') url.searchParams.delete('view')
  else url.searchParams.set('view', v)
  window.history.replaceState(null, '', url.toString())
}

type Selected =
  | { kind: 'task'; task: MyDayTask }
  | { kind: 'event'; event: MyDayEvent }
  | { kind: 'eventDay'; eventDay: EventDayDto }
  | { kind: 'series'; series: RecurringSeriesDto }

// Upcoming surface (slice 9 + Ink redesign). Dated items are grouped by local
// day with relative labels; undated items fill a sticky Backlog card. Tasks
// can be checked off in place (optimistic); events are read-only here.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

export function UpcomingPage() {
  const [data, setData] = useState<Upcoming | null>(null)
  const [recurringData, setRecurringData] = useState<RecurringResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [recurringExpanded, setRecurringExpanded] = useState(true)
  const [view, setView] = useState<UpcomingView>(readViewParam)
  // Calendar month/week navigation state — start at the current month/today.
  const todayObj = useMemo(() => localToday(), [])
  const [calYear, setCalYear] = useState(() => Number(todayObj.date.slice(0, 4)))
  const [calMonth, setCalMonth] = useState(() => Number(todayObj.date.slice(5, 7)))
  const [weekAnchor, setWeekAnchor] = useState(() => todayObj.date)

  function switchView(v: UpcomingView) {
    setView(v)
    writeViewParam(v)
  }

  const refresh = useCallback(async () => {
    const { date, tz } = localToday()
    setLoading(true)
    try {
      // Upcoming is the critical fetch — a failure errors the page.
      const upcoming = await getUpcoming(date, tz)
      setData(upcoming)
      // Recurring is best-effort: if it fails, still show the schedule and
      // just hide the Recurring section rather than blanking the page.
      try {
        setRecurringData(await getRecurring(date, tz))
      } catch {
        setRecurringData(null)
      }
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

  const today = todayObj.date
  const groups = useMemo(() => (data ? groupUpcomingByDay(data.dated, today) : []), [data, today])

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
          items.filter((it) => !(it.kind === 'eventDay' && it.eventDay.eventId === eventDay.eventId))
        return { ...d, dated: filter(d.dated), undated: filter(d.undated) }
      })
    } catch (err) {
      setError(errMessage(err))
    }
  }

  // Backlog aside — shared between week and month calendar views.
  const backlogAside = (
    <aside className="pl-card up-backlog up-cal-backlog" style={{ padding: 15 }}>
      <EyeRow>No date · Backlog</EyeRow>
      {data?.undated.length === 0 ? (
        <p className="meta" style={{ color: 'var(--ink-mute)' }}>Backlog is empty.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
          {data?.undated.map((it) => {
            if (it.kind === 'eventDay') return null
            if (it.kind === 'event') {
              const ev = it.event
              return (
                <li
                  key={`event:${ev.id}`}
                  {...openProps(() => setSelected({ kind: 'event', event: ev }))}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
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
                {it.shared === true && (
                  <span className="pl-chip" style={{ color: 'var(--acid)' }}>
                    Shared
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )

  // Called when the user clicks an item chip in a calendar cell — routes to the
  // same drawer flow as clicking a row in the list view.
  function onCalendarItemClick(it: UpcomingItem) {
    if (it.kind === 'task') setSelected({ kind: 'task', task: it.task })
    else if (it.kind === 'event') setSelected({ kind: 'event', event: it.event })
    else if (it.kind === 'eventDay') setSelected({ kind: 'eventDay', eventDay: it.eventDay })
  }

  // Called when the user clicks a day cell in a calendar — scrolls to that
  // day's group in the list view. For now, switch to list view and let the
  // group header be found visually (a future enhancement could scroll-anchor).
  function onCalendarDayClick(_ymd: string) {
    switchView('list')
  }

  return (
    <>
      <div className="pg-head" style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>Upcoming</h1>
          <div className="sub">Everything on the horizon, soonest first.</div>
        </div>
        <div className="seg" style={{ alignSelf: 'flex-end', flexShrink: 0 }}>
          <button
            type="button"
            className={view === 'list' ? 'on' : ''}
            onClick={() => switchView('list')}
            aria-pressed={view === 'list'}
          >
            <Icon name="tasks" size={12} />
            List
          </button>
          <button
            type="button"
            className={view === 'week' ? 'on' : ''}
            onClick={() => switchView('week')}
            aria-pressed={view === 'week'}
          >
            <Icon name="upcoming" size={12} />
            Week
          </button>
          <button
            type="button"
            className={view === 'month' ? 'on' : ''}
            onClick={() => switchView('month')}
            aria-pressed={view === 'month'}
          >
            <Icon name="grid" size={12} />
            Month
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {loading && !data ? (
        <p style={{ color: 'var(--ink-dim)', fontSize: 14, margin: 0 }}>Loading…</p>
      ) : data ? (
        <>
          {/* Calendar views render outside the up-grid (full-width, no aside) */}
          {view === 'month' && (
            <div className="up-cal-wrap">
              <MonthGrid
                groups={groups}
                year={calYear}
                month={calMonth}
                todayYmd={today}
                onMonthChange={(y, m) => { setCalYear(y); setCalMonth(m) }}
                onDayClick={onCalendarDayClick}
                onItemClick={onCalendarItemClick}
              />
              {backlogAside}
            </div>
          )}
          {view === 'week' && (
            <div className="up-cal-wrap">
              <WeekStrip
                groups={groups}
                anchorYmd={weekAnchor}
                todayYmd={today}
                onWeekChange={setWeekAnchor}
                onDayClick={onCalendarDayClick}
                onItemClick={onCalendarItemClick}
              />
              {backlogAside}
            </div>
          )}
          {view === 'list' && (
        <div className="up-grid">
          <div>
            {recurringData && recurringData.recurring.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <div className="pl-dategroup" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => setRecurringExpanded((x) => !x)}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="repeat" size={13} />
                    <span className="d">Recurring</span>
                  </span>
                  <span className="rel" style={{ fontSize: 12 }}>{recurringData.recurring.length} series</span>
                  <span className="ln" />
                  <span style={{ fontSize: 11, color: 'var(--ink-dim)', marginLeft: 4 }}>{recurringExpanded ? '▲' : '▼'}</span>
                </div>
                {recurringExpanded && (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 7 }}>
                    {recurringData.recurring.map((sr) => (
                      <li
                        key={sr.id}
                        className="pl-row"
                        {...openProps(() => setSelected({ kind: 'series', series: sr }))}
                        style={{ gridTemplateColumns: '1fr auto', alignItems: 'center', cursor: 'pointer' }}
                      >
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                          <span style={{ fontSize: 13.5, color: 'var(--ink)' }}>{sr.title}</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            <span className="eyebrow" style={{ color: 'var(--ink-mute)' }}>{sr.listName}</span>
                            <span className="pl-chip repeat" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <Icon name="repeat" size={10} />
                              {describeRecurrence(sr)}
                            </span>
                          </span>
                          <span className="meta" style={{ color: 'var(--ink-dim)', fontSize: 12 }}>
                            {summarizeNext(sr.next)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {groups.length === 0 ? (
              <p className="meta" style={{ color: 'var(--ink-mute)' }}>Nothing scheduled ahead.</p>
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
                      if (it.kind === 'eventDay') {
                        const ed = it.eventDay
                        const allDay = ed.startTime == null
                        return (
                          <li
                            key={`eventDay:${ed.eventId}@${ed.date}`}
                            className="pl-row"
                            {...openProps(() => setSelected({ kind: 'eventDay', eventDay: ed }))}
                            style={{ gridTemplateColumns: '1fr auto', alignItems: 'center', cursor: 'pointer' }}
                          >
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                              <span style={{ fontSize: 13.5, color: 'var(--ink)' }}>{ed.name}</span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                                <span className="eyebrow" style={{ color: 'var(--acid)' }}>event</span>
                                {ed.dayLabel && (
                                  <span className="meta" style={{ color: 'var(--ink-mute)' }}>{ed.dayLabel}</span>
                                )}
                                {allDay && <span className="pl-chip">All day</span>}
                                {ed.shared && (
                                  <span className="pl-chip" style={{ borderColor: 'var(--acid-dim, var(--acid))', color: 'var(--acid)' }}>
                                    Shared
                                  </span>
                                )}
                              </span>
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 9, alignSelf: 'flex-start' }}>
                              {!allDay && (
                                <span className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
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
                      // Tasks carry a date-only due date (stored as midnight) — show a
                      // time only when one was actually set, else it reads as a bogus
                      // local-converted hour (e.g. 5 PM). Events always carry a real instant.
                      const timeLabel = isTask
                        ? hasTimeOfDay(it.task.dueDate)
                          ? fmtTime(it.task.dueDate)
                          : ''
                        : fmtTime(it.event.startAt)
                      const loc = isTask ? null : it.event.locationLabel
                      const repeats = isTask && it.task.seriesId != null
                      const ticket = !isTask && it.event.ticketCount > 0
                      const priority = isTask ? it.task.priority : null
                      const shared = isTask && it.kind === 'task' && it.shared === true
                      const key = isTask ? `task:${it.task.id}` : `event:${it.event.id}`
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
                          <span style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                            <span
                              style={{
                                fontSize: 13.5,
                                color: completed ? 'var(--ink-mute)' : 'var(--ink)',
                                textDecoration: completed ? 'line-through' : 'none',
                              }}
                            >
                              {title}
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                              <span className="eyebrow" style={{ color: isTask ? 'var(--ink-mute)' : 'var(--acid)' }}>
                                {it.kind}
                              </span>
                              {loc && (
                                <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <Icon name="pin" size={10} />
                                  {loc}
                                </span>
                              )}
                              {repeats && (() => {
                                const sr = recurringData?.recurring.find(
                                  (s) => isTask && it.kind === 'task' && s.id === it.task.seriesId,
                                ) ?? null
                                return (
                                  <span
                                    className="pl-chip repeat"
                                    role={sr ? 'button' : undefined}
                                    tabIndex={sr ? 0 : undefined}
                                    onClick={sr ? (e) => { stop(e); setSelected({ kind: 'series', series: sr }) } : undefined}
                                    onKeyDown={sr ? (e) => { if (e.key === 'Enter' || e.key === ' ') { stop(e as unknown as MouseEvent); setSelected({ kind: 'series', series: sr }) } } : undefined}
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: sr ? 'pointer' : 'default' }}
                                  >
                                    <Icon name="repeat" size={10} />
                                    {sr ? 'Edit series' : 'Repeats'}
                                  </span>
                                )
                              })()}
                              {shared && (
                                <span className="pl-chip" style={{ borderColor: 'var(--acid-dim, var(--acid))', color: 'var(--acid)' }}>
                                  Shared
                                </span>
                              )}
                              {ticket && <span className="pl-chip accent">Ticket</span>}
                            </span>
                          </span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 9, alignSelf: 'flex-start' }}>
                            {timeLabel && (
                              <span className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
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
              <p className="meta" style={{ color: 'var(--ink-mute)' }}>Backlog is empty.</p>
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
                        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
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
                      {it.shared === true && (
                        <span className="pl-chip" style={{ color: 'var(--acid)' }}>
                          Shared
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </aside>
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
        {selected?.kind === 'series' && (
          <SeriesEdit
            series={selected.series}
            onChanged={() => void refresh()}
            onClose={() => setSelected(null)}
          />
        )}
      </Drawer>
    </>
  )
}
