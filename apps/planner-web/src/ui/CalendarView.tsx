// Calendar views for the Upcoming page: a month grid and a week strip.
// Pure presentational — all data comes through props; no fetches, no state
// beyond the +N-more overflow expansion (local per-cell).

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

  return (
    <div className="cal-month" data-noswipe>
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
    const dt = new Date(y, (m ?? 1) - 1, (d ?? 1) - 7)
    onWeekChange(
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
    )
  }
  function nextWeek() {
    const [y, m, d] = anchorYmd.split('-').map(Number)
    const dt = new Date(y, (m ?? 1) - 1, (d ?? 1) + 7)
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
      <div className="cal-grid cal-grid--week">
        {dowLabels.map((lbl) => (
          <div key={lbl} className="cal-dow-hdr">
            {lbl}
          </div>
        ))}
        {cells.map((cell) => (
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
  )
}
