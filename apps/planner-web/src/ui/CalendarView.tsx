// Calendar views for the Upcoming page: a month grid and a week list.
// Pure presentational — all data comes through props; no fetches, no state
// beyond the +N-more overflow expansion (local per-cell) and the mobile
// month-view's selected day (local per-render of MonthMini).
//
// Three exports, two variants:
//   MonthGrid  — desktop full grid (>=601px) + delegates to MonthMini on mobile
//   MonthMini  — phone-only iOS-Calendar pattern (dot grid + agenda below)
//   WeekStrip  — vertical list of day cards (`.wk-list` / `.wk-day` / etc.)
//
// Both month variants live behind a `@media (max-width: 600px)` switch in
// apps/planner-web/src/index.css that hides whichever variant isn't
// appropriate; React renders both wrapped in `.cal-month-desktop` /
// `.cal-month-mobile` so the swap is paint-only (no layout thrash).

import { useEffect, useMemo, useState, type ReactElement } from 'react'

import type { CalendarCell, UpcomingGroup } from '../lib/planner-helpers.js'
import {
  buildMonthGrid,
  buildWeekStrip,
  groupDateLabel,
  relativeDayLabel,
} from '../lib/planner-helpers.js'
import type { UpcomingItem } from '../lib/api.js'
import { Icon } from './icons.js'

// Maximum items shown in a calendar cell before the "+N more" overflow badge.
const MAX_VISIBLE = 3

// ── Day-of-week header labels ──────────────────────────────────────

const DOW_LABELS_SUN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_LABELS_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// ── Item chip ─────────────────────────────────────────────────────

function ItemChip({
  item,
  onClick,
}: {
  item: UpcomingItem
  onClick: (item: UpcomingItem) => void
}) {
  const isTask = item.kind === 'task'
  const isEventDay = item.kind === 'eventDay'
  const isHoliday = item.kind === 'holiday'
  const title = isTask
    ? item.task.title
    : isEventDay
      ? item.eventDay.name
      : isHoliday
        ? item.holiday.name
        : item.event.name
  const completed = isTask ? item.task.completed : false

  // Every chip — events, tasks, eventDays, and holidays — is a button that
  // surfaces the item's detail. Holidays open a read-only detail (the page
  // handler decides; clicking never enters an edit form for a built-in one).
  return (
    <button
      type="button"
      className="cal-chip"
      data-kind={item.kind}
      data-completed={completed || undefined}
      onClick={(e) => {
        e.stopPropagation()
        onClick(item)
      }}
      title={title}
    >
      <span className="cal-chip-label">{title}</span>
    </button>
  )
}

// ── Single cell ───────────────────────────────────────────────────

function CalCell({
  cell,
  todayYmd,
  onDayClick,
  onItemClick,
}: {
  cell: CalendarCell
  todayYmd: string
  onDayClick: (ymd: string) => void
  onItemClick: (item: UpcomingItem) => void
}) {
  const isToday = cell.date === todayYmd
  const dayNum = Number(cell.date.slice(8))
  const visible = cell.items.slice(0, MAX_VISIBLE)
  const overflow = cell.items.length - visible.length

  return (
    <div
      className={
        'cal-cell' +
        (!cell.inCurrentMonth ? ' out-month' : '') +
        (isToday ? ' is-today' : '')
      }
      role="button"
      tabIndex={0}
      onClick={() => onDayClick(cell.date)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onDayClick(cell.date)
      }}
      aria-label={`${cell.date}${cell.items.length ? `, ${cell.items.length} item${cell.items.length > 1 ? 's' : ''}` : ''}`}
    >
      <span className="cal-day-num">{dayNum}</span>
      <div className="cal-items">
        {visible.map((it) => (
          <ItemChip
            key={
              it.kind === 'task' ? `task:${it.task.id}` :
              it.kind === 'event' ? `event:${it.event.id}` :
              it.kind === 'holiday' ? `holiday:${it.holiday.id}` :
              `eventDay:${it.eventDay.eventId}@${it.eventDay.date}`
            }
            item={it}
            onClick={onItemClick}
          />
        ))}
        {overflow > 0 && (
          <span className="cal-overflow">+{overflow} more</span>
        )}
      </div>
    </div>
  )
}

// ── Month grid ────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function MonthGrid({
  groups,
  year,
  month,
  todayYmd,
  weekStart = 0,
  onMonthChange,
  onDayClick,
  onItemClick,
}: {
  groups: UpcomingGroup[]
  year: number
  month: number
  todayYmd: string
  weekStart?: 0 | 1
  onMonthChange: (year: number, month: number) => void
  onDayClick: (ymd: string) => void
  onItemClick: (item: UpcomingItem) => void
}) {
  const rows = buildMonthGrid(groups, year, month, weekStart)
  const dowLabels = weekStart === 1 ? DOW_LABELS_MON : DOW_LABELS_SUN

  function prevMonth() {
    if (month === 1) onMonthChange(year - 1, 12)
    else onMonthChange(year, month - 1)
  }
  function nextMonth() {
    if (month === 12) onMonthChange(year + 1, 1)
    else onMonthChange(year, month + 1)
  }

  const navHeader = (
    <div className="cal-nav">
      <button
        type="button"
        className="pl-iconbtn"
        onClick={prevMonth}
        aria-label="Previous month"
      >
        <span style={{ display: 'flex', transform: 'rotate(180deg)' }}>
          <Icon name="chevron" size={14} />
        </span>
      </button>
      <span className="cal-nav-title">
        {MONTH_NAMES[(month - 1) % 12]} {year}
      </span>
      <button
        type="button"
        className="pl-iconbtn"
        onClick={nextMonth}
        aria-label="Next month"
      >
        <Icon name="chevron" size={14} />
      </button>
    </div>
  )

  return (
    <div className="cal-month" data-noswipe>
      {/* Desktop variant: the full `.cal-grid` matrix. Hidden by CSS
          below 601px. */}
      <div className="cal-month-desktop">
        {navHeader}
        <div className="cal-grid">
          {dowLabels.map((lbl) => (
            <div key={lbl} className="cal-dow-hdr">
              {lbl}
            </div>
          ))}
          {rows.flat().map((cell) => (
            <CalCell
              key={cell.date}
              cell={cell}
              todayYmd={todayYmd}
              onDayClick={onDayClick}
              onItemClick={onItemClick}
            />
          ))}
        </div>
      </div>
      {/* Phone-only variant: dot grid + agenda below. Hidden by CSS
          above 600px. */}
      <div className="cal-month-mobile">
        <MonthMini
          rows={rows}
          dowLabels={dowLabels}
          todayYmd={todayYmd}
          onItemClick={onItemClick}
          navHeader={navHeader}
        />
      </div>
    </div>
  )
}

// ── Mobile compact month view ─────────────────────────────────────

/**
 * iOS-Calendar pattern: a tight 7-column dot grid (each cell shows day
 * number + up to two colored dots: gray for tasks, accent for events)
 * with a `.cal-agenda` panel below that lists the selected day's items.
 * Selecting a day re-renders the agenda; the selection is local-state
 * so it survives swiping between months only as long as the component
 * stays mounted (intentional — a fresh month should start at today /
 * the first day with items).
 */
function MonthMini({
  rows,
  dowLabels,
  todayYmd,
  onItemClick,
  navHeader,
}: {
  rows: CalendarCell[][]
  dowLabels: string[]
  todayYmd: string
  onItemClick: (item: UpcomingItem) => void
  navHeader: ReactElement
}) {
  const flat = useMemo(() => rows.flat(), [rows])
  // Identify the rendered month by its first in-current-month YMD's
  // year-month prefix (`'YYYY-MM'`). Changes when the user navigates
  // prev/next; the selection effect below resets `selDate` to a sane
  // default for the new month so the agenda doesn't go blank.
  const monthKey = useMemo(() => {
    const firstInMonth = flat.find((c) => c.inCurrentMonth)
    return firstInMonth?.date.slice(0, 7) ?? ''
  }, [flat])

  // Pick a sensible default selection for a given grid: today if it's
  // in the current month, else the first in-month day with items, else
  // the first in-month day.
  function defaultSelFor(cells: CalendarCell[]): string {
    const todayInMonth = cells.find(
      (c) => c.date === todayYmd && c.inCurrentMonth,
    )
    if (todayInMonth) return todayInMonth.date
    const firstWithItems = cells.find(
      (c) => c.inCurrentMonth && c.items.length > 0,
    )
    if (firstWithItems) return firstWithItems.date
    const firstInMonth = cells.find((c) => c.inCurrentMonth)
    return firstInMonth?.date ?? todayYmd
  }

  const [selDate, setSelDate] = useState<string>(() => defaultSelFor(flat))

  // When the rendered month changes (prev/next nav), reset the
  // selection so the agenda stays in sync. Local-state edits within
  // the same month don't reset (only the monthKey transition does).
  // `flat` is rebuilt on every render but only re-derives when `rows`
  // changes; we intentionally gate on `monthKey` (and not `flat`) so
  // selection only resets when the user navigates to a different
  // month, not on every render.
  useEffect(() => {
    setSelDate(defaultSelFor(flat))
  }, [monthKey, flat])

  const selCell = flat.find((c) => c.date === selDate) ?? null
  const dowMini = dowLabels.map((d) => d.slice(0, 1))

  return (
    <>
      {navHeader}
      <div className="cal-mini" role="grid">
        {dowMini.map((d, i) => (
          <div key={`${d}-${i}`} className="cal-mini-dow">
            {d}
          </div>
        ))}
        {flat.map((cell) => {
          if (!cell.inCurrentMonth) {
            return <div key={cell.date} className="cal-day out" />
          }
          const isToday = cell.date === todayYmd
          const isSel = cell.date === selDate
          const hasEv = cell.items.some(
            (i) => i.kind === 'event' || i.kind === 'eventDay',
          )
          // Holidays render alongside tasks under the gray dot — they
          // share the "things to know about this day" visual role; only
          // events warrant the accent treatment.
          const hasTask = cell.items.some(
            (i) => i.kind === 'task' || i.kind === 'holiday',
          )
          const dayNum = Number(cell.date.slice(8))
          return (
            <button
              key={cell.date}
              type="button"
              className={
                'cal-day' +
                (isToday ? ' today' : '') +
                (isSel ? ' sel' : '')
              }
              aria-selected={isSel}
              aria-label={cell.date}
              onClick={() => setSelDate(cell.date)}
            >
              <span className="n">{dayNum}</span>
              {(hasEv || hasTask) && (
                <span className="cal-day-dots" aria-hidden>
                  {hasEv && <span className="cal-dot ev" />}
                  {hasTask && <span className="cal-dot" />}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <MonthMiniAgenda
        cell={selCell}
        todayYmd={todayYmd}
        onItemClick={onItemClick}
      />
    </>
  )
}

function MonthMiniAgenda({
  cell,
  todayYmd,
  onItemClick,
}: {
  cell: CalendarCell | null
  todayYmd: string
  onItemClick: (item: UpcomingItem) => void
}) {
  if (!cell) return null
  const isToday = cell.date === todayYmd
  return (
    <div className="cal-agenda">
      <div className="cal-agenda-hd">
        <span className="d">{groupDateLabel(cell.date)}</span>
        {isToday && (
          <span
            className="pl-chip accent"
            aria-label="Today"
            style={{ marginLeft: 'auto' }}
          >
            Today
          </span>
        )}
      </div>
      {cell.items.length === 0 ? (
        <div className="cal-agenda-empty">Nothing scheduled</div>
      ) : (
        <div className="cal-agenda-list">
          {cell.items.map((it) => {
            const isEv = it.kind === 'event' || it.kind === 'eventDay'
            const title =
              it.kind === 'task'
                ? it.task.title
                : it.kind === 'eventDay'
                  ? it.eventDay.name
                  : it.kind === 'holiday'
                    ? it.holiday.name
                    : it.event.name
            const key =
              it.kind === 'task'
                ? `task:${it.task.id}`
                : it.kind === 'event'
                  ? `event:${it.event.id}`
                  : it.kind === 'holiday'
                    ? `holiday:${it.holiday.id}`
                    : `eventDay:${it.eventDay.eventId}@${it.eventDay.date}`
            // Collapse the discriminated-union's internal kind to the
            // user-facing role label (the agenda doesn't need to
            // distinguish `event` vs `eventDay`).
            const kindLabel =
              it.kind === 'eventDay' ? 'event' : it.kind
            return (
              <button
                key={key}
                type="button"
                className="cal-agenda-item"
                onClick={() => onItemClick(it)}
              >
                <span
                  className={'cal-dot' + (isEv ? ' ev' : '')}
                  aria-hidden
                />
                <span className="t">{title}</span>
                <span className="k">{kindLabel}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Week strip ────────────────────────────────────────────────────

export function WeekStrip({
  groups,
  anchorYmd,
  todayYmd,
  weekStart = 0,
  onWeekChange,
  onDayClick,
  onItemClick,
}: {
  groups: UpcomingGroup[]
  anchorYmd: string
  todayYmd: string
  weekStart?: 0 | 1
  onWeekChange: (anchorYmd: string) => void
  onDayClick: (ymd: string) => void
  onItemClick: (item: UpcomingItem) => void
}) {
  const cells = buildWeekStrip(groups, anchorYmd, weekStart)
  const dowLabels = weekStart === 1 ? DOW_LABELS_MON : DOW_LABELS_SUN

  // Navigate by 7 days forward / back
  function prevWeek() {
    const [y, m, d] = anchorYmd.split('-').map(Number)
    const dt = new Date(y ?? NaN, (m ?? 1) - 1, (d ?? 1) - 7)
    onWeekChange(
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
    )
  }
  function nextWeek() {
    const [y, m, d] = anchorYmd.split('-').map(Number)
    const dt = new Date(y ?? NaN, (m ?? 1) - 1, (d ?? 1) + 7)
    onWeekChange(
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
    )
  }

  // Range label: e.g. "Jun 9 – Jun 15"
  const first = cells[0]?.date ?? anchorYmd
  const last = cells[6]?.date ?? anchorYmd
  const rangeLabel = `${groupDateLabel(first)} – ${groupDateLabel(last)}`
  const rel = relativeDayLabel(anchorYmd, todayYmd)

  return (
    <div className="cal-week" data-noswipe>
      <div className="cal-nav">
        <button
          type="button"
          className="pl-iconbtn"
          onClick={prevWeek}
          aria-label="Previous week"
        >
          <span style={{ display: 'flex', transform: 'rotate(180deg)' }}>
            <Icon name="chevron" size={14} />
          </span>
        </button>
        <span className="cal-nav-title">
          {rangeLabel}
          {rel !== 'Overdue' && (
            <span className="cal-nav-rel">{rel}</span>
          )}
        </span>
        <button
          type="button"
          className="pl-iconbtn"
          onClick={nextWeek}
          aria-label="Next week"
        >
          <Icon name="chevron" size={14} />
        </button>
      </div>
      {/* Kit's vertical-list Week view: one .wk-day card per day, each
          with a left rail (dow label + big day number) and a right
          items list. Replaces the prior `.cal-grid--week` 7-column
          variant which shared CalCell with MonthGrid. */}
      <div className="wk-list">
        {cells.map((cell, idx) => {
          const isToday = cell.date === todayYmd
          const dayNum = Number(cell.date.slice(8))
          const dow = dowLabels[idx % 7] ?? ''
          return (
            <div
              key={cell.date}
              className={'wk-day' + (isToday ? ' is-today' : '')}
            >
              <button
                type="button"
                className="wk-rail"
                onClick={() => onDayClick(cell.date)}
                aria-label={`Open ${cell.date}`}
                style={{ all: 'unset', cursor: 'pointer' }}
              >
                <span className="wk-dow">{dow}</span>
                <span className="wk-dnum">{dayNum}</span>
              </button>
              <div className="wk-items">
                {cell.items.length === 0 ? (
                  <span className="wk-empty">Nothing scheduled</span>
                ) : (
                  cell.items.map((it) => {
                    const isEv = it.kind === 'event' || it.kind === 'eventDay'
                    const title =
                      it.kind === 'task'
                        ? it.task.title
                        : it.kind === 'eventDay'
                          ? it.eventDay.name
                          : it.kind === 'holiday'
                            ? it.holiday.name
                            : it.event.name
                    const completed =
                      it.kind === 'task' ? it.task.completed : false
                    const key =
                      it.kind === 'task'
                        ? `task:${it.task.id}`
                        : it.kind === 'event'
                          ? `event:${it.event.id}`
                          : it.kind === 'holiday'
                            ? `holiday:${it.holiday.id}`
                            : `eventDay:${it.eventDay.eventId}@${it.eventDay.date}`
                    return (
                      <button
                        key={key}
                        type="button"
                        className={'wk-item' + (isEv ? ' ev' : '')}
                        data-completed={completed || undefined}
                        onClick={(e) => {
                          e.stopPropagation()
                          onItemClick(it)
                        }}
                        title={title}
                      >
                        <span className="wk-dot" aria-hidden />
                        {title}
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
