import { useMemo, useState } from 'react'
import {
  deleteTaskItem,
  LAST_CHECKIN_DAY_KEY,
  setGroupEventPlannerPref,
  SHOW_CHORES_IN_FEEDS_KEY,
  updateSettings,
  type EventDayDto,
  type HolidayDto,
  type MyDayEvent,
  type MyDayTask,
  type TaskSeriesDto,
} from '../lib/api.js'
import { useSession } from '../lib/session.js'
import { fmtTime, localToday, mydayStatusLabel } from '../lib/planner-helpers.js'
import { holidaysOnDay, hiddenHolidays } from '../lib/holidays-helpers.js'
import { choresInFeedsEnabled, splitChoresFromTasks } from '../lib/chores-helpers.js'
import { MorningCheckin } from '../ui/MorningCheckin.js'
import { type SeriesSurface } from '../lib/series-lookup.js'
import { ConfirmDialog, SubBar, SubBarSeg } from '@rallypoint/ui'
import { QuickAdd } from '../ui/QuickAdd.js'
import { Icon } from '../ui/icons.js'
import { EyeRow } from '../ui/bits.js'
import { WeatherStrip } from '../ui/WeatherStrip.js'
import { SkeletonBlock, SkeletonRows } from '../ui/Skeleton.js'
import { UpcomingFeed } from './UpcomingFeed.js'
import { CalendarBody } from './CalendarBody.js'
import { errMessage, headingLabel, buildMyDayView } from '../lib/my-day-sections.js'
import { useMyDayData } from '../lib/use-my-day-data.js'
import { useTaskToggle } from '../lib/use-task-toggle.js'
import { MyDayAllDaySection } from './MyDayAllDaySection.js'
import { MyDayTimeline } from './MyDayTimeline.js'
import { MyDayChoresSection } from './MyDayChoresSection.js'
import { MyDayTasksSection } from './MyDayTasksSection.js'
import { MyDayTrainingSection } from './MyDayTrainingSection.js'
import { MyDayDetailDrawers } from './MyDayDetailDrawers.js'

export type Selected =
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

export function MyDayPage() {
  const session = useSession()
  const [selected, setSelected] = useState<Selected | null>(null)
  // Swipe/hover Delete on a task row stages it here; the ConfirmDialog
  // commits the delete.
  const [confirmDelete, setConfirmDelete] = useState<MyDayTask | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const today = useMemo(() => localToday().date, [])

  const {
    data,
    setData,
    upcoming,
    visibleHolidays,
    plannerSettings,
    setPlannerSettings,
    seriesLookup,
    choresListId,
    defaultTaskListId,
    personalTaskListIds,
    showCheckin,
    setShowCheckin,
    loading,
    error,
    setError,
    dayView,
    changeDayView,
    refresh,
  } = useMyDayData({ today })

  const { busyId, isChoreTask, toggle } = useTaskToggle({
    data,
    setData,
    setError,
    choresListId,
    personalTaskListIds,
  })

  // Commit a staged swipe-delete. Task rows only (the tray never renders on
  // chore rows — deleting a chore occurrence isn't a Planner operation; its
  // series is managed via the drawer). The roll-up aggregates re-derive on
  // refresh rather than patching state shapes here.
  async function onDeleteTask(task: MyDayTask) {
    setDeleteBusy(true)
    setError(null)
    try {
      await deleteTaskItem(task.listId, task.id)
      void refresh()
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setDeleteBusy(false)
      setConfirmDelete(null)
    }
  }

  // Today's chores live in `data.tasks` (the BFF always emits them for
  // scope='today'). Derive them eagerly so the modal mount doesn't have to
  // wait on the `view` memo, which only resolves once `data` is non-null.
  const todaysChores = useMemo(() => {
    if (!data) return [] as MyDayTask[]
    return splitChoresFromTasks(data.tasks, choresListId).chores
  }, [data, choresListId])

  async function handleCheckinDone(): Promise<void> {
    // Persist today's local date so the modal stays closed until tomorrow,
    // and reflect the write locally so a refetch isn't required to close it.
    // The modal closes locally on success; on failure we still close (the
    // user already saw the modal — trapping them in it would be worse) but
    // surface the error so they know the next-day gate didn't record.
    // Without this they'd see the modal again on next session for the same day.
    setShowCheckin(false)
    setPlannerSettings((s) => ({ ...s, [LAST_CHECKIN_DAY_KEY]: today }))
    try {
      await updateSettings('planner', { [LAST_CHECKIN_DAY_KEY]: today })
    } catch (err) {
      setError(errMessage(err))
    }
    // A successful commit may have added tasks or toggled chores — refetch
    // so the new rows + chore states appear on My Day immediately.
    void refresh()
  }

  // The "chores in future views" toggle (Upcoming + Week + Month). Reads from
  // the planner settings blob and writes back optimistically — Settings page
  // edits the same key (SHOW_CHORES_IN_FEEDS_KEY) so the two surfaces stay in
  // sync after either changes it. On server failure the optimistic patch is
  // rolled back and the error surfaced (mirrors the toggle() pattern above).
  const showChoresFuture = choresInFeedsEnabled(plannerSettings)
  async function toggleChoresInFuture(): Promise<void> {
    const prev = showChoresFuture
    const next = !prev
    setPlannerSettings((s) => ({ ...s, [SHOW_CHORES_IN_FEEDS_KEY]: next }))
    try {
      await updateSettings('planner', { [SHOW_CHORES_IN_FEEDS_KEY]: next })
      // Upcoming + Week/Month rely on the server feed which gates on this
      // setting, so the next refresh sees the change.
      void refresh()
    } catch (err) {
      // Roll back the optimistic patch so the UI matches server state.
      setPlannerSettings((s) => ({ ...s, [SHOW_CHORES_IN_FEEDS_KEY]: prev }))
      setError(errMessage(err))
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
    return buildMyDayView(data, today, choresListId)
  }, [data, today, choresListId])

  return (
    <>
      {showCheckin && (
        <MorningCheckin
          firstName={session.profile?.first_name ?? ''}
          dateLabel={headingLabel(today)}
          chores={todaysChores}
          taskListId={defaultTaskListId}
          todayYmd={today}
          choresListId={choresListId}
          onDone={handleCheckinDone}
        />
      )}
      <div className="pg-head pl-wide" style={{ marginBottom: 10 }}>
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
        {/* Chores visibility toggle: on Agenda the label flips to "Chores in
            upcoming" (Coming up gates on the same setting); on Week/Month the
            label is "Show chores" (toggling reveals chore rows in future
            days). Today's Chores section is unconditional in both lenses. */}
        <button
          type="button"
          className={'chores-toggle' + (showChoresFuture ? ' on' : '')}
          aria-pressed={showChoresFuture}
          onClick={toggleChoresInFuture}
          title={
            dayView === 'agenda'
              ? 'Show chores in Coming up'
              : 'Show recurring chores on future days'
          }
        >
          {dayView === 'agenda' ? 'Chores in upcoming' : 'Show chores'}
        </button>
      </div>

      {/* Mobile-only floating sub-bar (Ink kit). The desktop
          `.md-toolbar` above is hidden via responsive CSS at <1024px;
          this `.rp-subbar` takes over with the same Agenda/Week/Month
          segments + the trailing QuickAdd FAB per the kit. The
          `.rp-fab-float` coordinates on no-sub-bar pages were tuned to
          match where this in-sub-bar FAB sits, so navigating to
          Notes/Diary/etc. doesn't visibly shift the FAB. */}
      <div className="plan-mobile-only">
        <SubBar label="My Day view">
          <SubBarSeg active={dayView === 'agenda'} onClick={() => changeDayView('agenda')}>
            Agenda
          </SubBarSeg>
          <SubBarSeg active={dayView === 'week'} onClick={() => changeDayView('week')}>
            Week
          </SubBarSeg>
          <SubBarSeg active={dayView === 'month'} onClick={() => changeDayView('month')}>
            Month
          </SubBarSeg>
          {dayView !== 'agenda' && (
            <button
              type="button"
              className={'pm-choretog' + (showChoresFuture ? ' on' : '')}
              aria-pressed={showChoresFuture}
              aria-label={showChoresFuture ? 'Hide chores on future days' : 'Show chores on future days'}
              title={showChoresFuture ? 'Hide chores on future days' : 'Show chores on future days'}
              onClick={toggleChoresInFuture}
            >
              <Icon name="tasks" size={16} />
            </button>
          )}
          <QuickAdd anchor="subbar" />
        </SubBar>
      </div>
      {/* Desktop: standalone floating FAB (no sub-bar). Wrapped in
          `.plan-desktop-only` so it doesn't double-render on mobile,
          where the sub-bar already owns the FAB. */}
      <div className="plan-desktop-only">
        <QuickAdd anchor="float" />
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
              {/* Mirror the agenda layout (weather card + summary strip +
                  a few schedule rows) so the real content swaps in without
                  a jump. The summary is one thin row, not three tiles. */}
              <SkeletonBlock height={56} style={{ marginBottom: 14 }} />
              <SkeletonBlock height={42} style={{ marginBottom: 14 }} />
              <SkeletonRows count={3} height={48} bare />
            </div>
          ) : view ? (
            <div className="md-agenda-grid">
              {/* Desktop (≥1024px): a two-pane dashboard — today's stack
                  (left) + a sticky "Coming up" rail (right). Below 1024px
                  .md-agenda-grid is a plain block, so the panes stack in
                  source order (today → coming-up), unchanged from before.
                  Inner content keeps its prior indentation to keep this a
                  minimal structural wrap. */}
              <div className="md-today">
              <WeatherStrip />
              {/* Compact summary strip per the Ink kit — replaces the prior
                  3-tile .md-stats block. One row: `N tasks left · dot · N
                  events today · clock-icon HH:MM · Next title` (next chip
                  floats right via .s.next, wraps below on narrow widths). */}
              <div className="md-summary">
                <span className="s">
                  <b>{view.left}</b> {view.left === 1 ? 'task' : 'tasks'} left
                </span>
                <span className="dot" aria-hidden />
                <span className="s">
                  <b>{view.eventsCount}</b>{' '}
                  {view.eventsCount === 1 ? 'event' : 'events'} today
                </span>
                {view.next && (
                  <span className="s next">
                    <Icon name="clock" size={13} />
                    {fmtTime(view.next.at)} · {view.next.title}
                  </span>
                )}
              </div>

              <MyDayAllDaySection
                allDay={view.allDay}
                allDayEvents={view.allDayEvents}
                allDayPersonalEvents={view.allDayPersonalEvents}
                todayHolidays={todayHolidays}
                today={today}
                choresListId={choresListId}
                seriesLookup={seriesLookup}
                busyId={busyId}
                isChoreTask={isChoreTask}
                toggle={toggle}
                onDeleteTask={setConfirmDelete}
                onSelect={setSelected}
                onRemoveEventFromPlanner={onRemoveEventFromPlanner}
              />

              <MyDayTimeline
                timeline={view.timeline}
                choresListId={choresListId}
                seriesLookup={seriesLookup}
                busyId={busyId}
                toggle={toggle}
                onSelect={setSelected}
                onRemoveEventFromPlanner={onRemoveEventFromPlanner}
              />

              <MyDayChoresSection
                chores={view.chores}
                today={today}
                seriesLookup={seriesLookup}
                busyId={busyId}
                toggle={toggle}
                onSelect={setSelected}
              />

              <MyDayTasksSection
                undatedTasks={data?.undatedTasks ?? []}
                choresListId={choresListId}
                seriesLookup={seriesLookup}
                busyId={busyId}
                isChoreTask={isChoreTask}
                toggle={toggle}
                onDeleteTask={setConfirmDelete}
                onSelect={setSelected}
              />

              <MyDayTrainingSection training={data?.training ?? []} />

              </div>
              {upcoming && (
                <div className="md-upnext">
                  <EyeRow>Coming up</EyeRow>
                  <UpcomingFeed
                    data={upcoming}
                    holidays={visibleHolidays}
                    seriesLookup={seriesLookup}
                    choresListId={choresListId}
                    todayYmd={today}
                    showChores={showChoresFuture}
                    onToggleShowChores={() => void toggleChoresInFuture()}
                    onHideHoliday={hideHoliday}
                    onChanged={() => void refresh()}
                  />
                </div>
              )}
            </div>
          ) : null}

          <ConfirmDialog
            open={confirmDelete !== null}
            title="Delete task?"
            body={confirmDelete ? `“${confirmDelete.title}” will be removed.` : undefined}
            confirmLabel="Delete"
            confirmVariant="hot"
            busy={deleteBusy}
            onConfirm={() => {
              if (confirmDelete) void onDeleteTask(confirmDelete)
            }}
            onCancel={() => setConfirmDelete(null)}
          />

          <MyDayDetailDrawers
            selected={selected}
            onClose={() => setSelected(null)}
            onChanged={() => void refresh()}
            onHideHoliday={hideHoliday}
          />
        </>
      )}
    </>
  )
}
