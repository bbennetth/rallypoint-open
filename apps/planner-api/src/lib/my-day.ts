import type { ListItemDto } from '@rallypoint/lists-client'
import type { PersonalEventDto, UserEventDto } from '@rallypoint/events-client'
import { dayInstant, type DayWindow } from './day-window.js'
import { expandEventDays, isAllDay, type EventDayItem } from './event-days.js'

// Pure My Day composition: given the actor's task items and personal events,
// keep the ones that fall inside the day's UTC window and order them by time.
// The window is the single source of truth — the Events SDK from/to is only a
// payload optimisation, so this re-filters both inputs to [start, end). This
// is the Planner BFF's own aggregation (modelled on events-api's group-day),
// not domain logic, so it lives here rather than in a shared SDK package.

export interface MyDay {
  date: string
  timezone: string
  tasks: ListItemDto[] // due within the day + overdue-and-open rolled forward; soonest first
  undatedTasks: ListItemDto[] // no dueDate; priority asc (high first) then title
  events: PersonalEventDto[] // starting within the day, soonest first
  eventDays: EventDayItem[] // group event days falling on the day, all-day first
}

// Numeric-instant membership in the half-open window [start, end). Parsing
// rather than string-comparing keeps it correct regardless of how upstream
// formats its instants (offset vs Z, millis precision).
function inWindow(instant: string, startMs: number, endMs: number): boolean {
  const t = Date.parse(instant)
  return Number.isFinite(t) && t >= startMs && t < endMs
}

const DAY_MS = 86_400_000

// Whether a personal event covers any part of the window [startMs, endMs) — so a
// multi-day event shows on EVERY day it spans, not only the day it starts.
// Half-open like the rest of the planner: it touches the window when it starts
// before the window ends AND its effective end is after the window starts.
//   - A point event (no usable endAt) collapses to its start instant, so it's
//     kept exactly when that instant is in [startMs, endMs) — the old behaviour.
//   - A timed event's endAt is the real end instant (half-open: an event ending
//     exactly at the window start doesn't count for that day).
//   - An all-day event's endAt is local midnight of its inclusive LAST day, so
//     its covered span runs ~a day past that; +DAY_MS keeps the last day inside.
function eventOverlapsWindow(
  e: { startAt: string | null; endAt: string | null; allDay: boolean },
  startMs: number,
  endMs: number,
): boolean {
  if (e.startAt == null) return false
  const s = Date.parse(e.startAt)
  if (!Number.isFinite(s)) return false
  const rawEnd = e.endAt != null ? Date.parse(e.endAt) : NaN
  const hasEnd = Number.isFinite(rawEnd) && rawEnd > s
  const endEff = hasEnd ? (e.allDay ? rawEnd + DAY_MS : rawEnd) : s + 1
  return s < endMs && endEff > startMs
}

// Priority rank for undated-task ordering: high → medium → low → none/null.
// Lower number = sorts first.
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }
function priorityRank(p: string | null | undefined): number {
  return p != null ? (PRIORITY_RANK[p] ?? 3) : 3
}

// Which dated tasks/chores show on this day. A dated item qualifies when its
// dueDate either falls inside today's window [start, end) (an "on-day"
// occurrence) OR is before the window AND the item is still open — an overdue
// task rolls forward into today and keeps rolling each day until it's completed
// (a completed-late item drops off; its dueDate is in the past and it's done).
//
// Recurring items (a shared seriesId) collapse to one row per day so a
// rolled-over occurrence never doubles up:
//   - if the series already has an on-day occurrence, that one wins and the
//     overdue copies are dropped — "the next occurrence is also on that same
//     day, so don't show it twice";
//   - otherwise the single longest-overdue occurrence stands in for the series.
// One-off items (seriesId null) never collapse — they can't recur, so every
// rolled-over one-off is shown.
//
// Output is ordered by dueDate ascending then title, so overdue items (due
// before the window) naturally lead, then today's items in time order.
function selectDayTasks(tasks: ListItemDto[], startMs: number, endMs: number): ListItemDto[] {
  const onDay: ListItemDto[] = []
  const overdue: ListItemDto[] = []
  for (const t of tasks) {
    if (t.dueDate == null) continue
    const due = Date.parse(t.dueDate)
    if (!Number.isFinite(due)) continue
    if (due >= startMs && due < endMs) onDay.push(t)
    else if (due < startMs && !t.completed) overdue.push(t)
  }

  // Series already represented by an on-day occurrence: their overdue copies
  // are duplicates of the next occurrence landing on this same day → dropped.
  const seriesOnDay = new Set<string>()
  for (const t of onDay) if (t.seriesId != null) seriesOnDay.add(t.seriesId)

  // Roll overdue items in, longest-overdue (earliest dueDate) first so the
  // earliest occurrence is the one that represents a collapsed series; at most
  // one per recurring series.
  overdue.sort((a, b) => Date.parse(a.dueDate!) - Date.parse(b.dueDate!))
  const selected = [...onDay]
  const rolledSeries = new Set<string>()
  for (const t of overdue) {
    if (t.seriesId != null) {
      if (seriesOnDay.has(t.seriesId) || rolledSeries.has(t.seriesId)) continue
      rolledSeries.add(t.seriesId)
    }
    selected.push(t)
  }

  return selected.sort((a, b) => {
    const ad = Date.parse(a.dueDate!)
    const bd = Date.parse(b.dueDate!)
    return ad !== bd ? ad - bd : a.title.localeCompare(b.title)
  })
}

export function composeMyDay(input: {
  date: string
  timezone: string
  window: DayWindow
  tasks: ListItemDto[]
  events: PersonalEventDto[]
  userEvents: UserEventDto[] // group (festival) events, expanded per day
  /** Group event ids that should be marked shared in the output (planner-flagged). */
  sharedEventIds?: readonly string[]
}): MyDay {
  const startMs = Date.parse(input.window.start)
  const endMs = Date.parse(input.window.end)
  const tz = input.timezone
  const sharedEventIds = new Set(input.sharedEventIds ?? [])

  // Dated tasks/chores: today's occurrences plus any overdue-and-still-open
  // items rolled forward into today, deduped per recurring series. See
  // selectDayTasks.
  const tasks: ListItemDto[] = selectDayTasks(input.tasks, startMs, endMs)

  // Undated tasks: no dueDate (null). Incomplete undated tasks always show.
  // Completed undated tasks drop off once their completedAt is no longer
  // within today's window; a null completedAt also drops off. Ordered by
  // priority (high→medium→low→none) then title for a stable, useful sort.
  const undatedTasks: ListItemDto[] = input.tasks
    .filter((t) => t.dueDate == null && (!t.completed || (t.completedAt != null && inWindow(t.completedAt, startMs, endMs))))
    .sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority)
      return pr !== 0 ? pr : a.title.localeCompare(b.title)
    })

  const events = input.events
    .filter((e) => eventOverlapsWindow(e, startMs, endMs))
    .sort((a, b) => {
      const as = Date.parse(a.startAt as string)
      const bs = Date.parse(b.startAt as string)
      return as !== bs ? as - bs : a.name.localeCompare(b.name)
    })

  const eventDays = expandEventDays(input.userEvents, sharedEventIds)
    .filter((d) => inWindow(dayInstant(d.date, d.startTime, tz), startMs, endMs))
    .sort((a, b) => {
      const ai = Date.parse(dayInstant(a.date, a.startTime, tz))
      const bi = Date.parse(dayInstant(b.date, b.startTime, tz))
      if (ai !== bi) return ai - bi
      // All-day days sort above timed days sharing the same instant.
      const ar = isAllDay(a) ? 0 : 1
      const br = isAllDay(b) ? 0 : 1
      if (ar !== br) return ar - br
      return a.name.localeCompare(b.name)
    })

  return { date: input.date, timezone: input.timezone, tasks, undatedTasks, events, eventDays }
}
