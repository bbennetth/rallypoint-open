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

// Task wrapper with optional shared marker. When `shared` is true the item
// came from a planner-flagged shared list (not the actor's personal scope).
export interface MyDayTaskItem extends ListItemDto {
  /** True when the task belongs to a planner-flagged shared list. */
  shared?: boolean
}

export interface MyDay {
  date: string
  timezone: string
  tasks: MyDayTaskItem[] // due within the day, soonest first
  undatedTasks: MyDayTaskItem[] // no dueDate; priority asc (high first) then title
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

// Priority rank for undated-task ordering: high → medium → low → none/null.
// Lower number = sorts first.
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }
function priorityRank(p: string | null | undefined): number {
  return p != null ? (PRIORITY_RANK[p] ?? 3) : 3
}

export function composeMyDay(input: {
  date: string
  timezone: string
  window: DayWindow
  tasks: ListItemDto[]
  events: PersonalEventDto[]
  userEvents: UserEventDto[] // group (festival) events, expanded per day
  /** List ids that should be marked shared in the output (planner-flagged). */
  sharedListIds?: readonly string[]
  /** Group event ids that should be marked shared in the output (planner-flagged). */
  sharedEventIds?: readonly string[]
}): MyDay {
  const startMs = Date.parse(input.window.start)
  const endMs = Date.parse(input.window.end)
  const tz = input.timezone
  const sharedIds = new Set(input.sharedListIds ?? [])
  const sharedEventIds = new Set(input.sharedEventIds ?? [])

  const tasks: MyDayTaskItem[] = input.tasks
    .filter((t) => t.dueDate != null && inWindow(t.dueDate, startMs, endMs))
    .map((t): MyDayTaskItem => ({
      ...t,
      ...(sharedIds.has(t.listId) ? { shared: true } : {}),
    }))
    .sort((a, b) => {
      const ad = Date.parse(a.dueDate as string)
      const bd = Date.parse(b.dueDate as string)
      return ad !== bd ? ad - bd : a.title.localeCompare(b.title)
    })

  // Undated tasks: no dueDate (null). Incomplete undated tasks always show.
  // Completed undated tasks drop off once their completedAt is no longer
  // within today's window; a null completedAt also drops off. Ordered by
  // priority (high→medium→low→none) then title for a stable, useful sort.
  const undatedTasks: MyDayTaskItem[] = input.tasks
    .filter((t) => t.dueDate == null && (!t.completed || (t.completedAt != null && inWindow(t.completedAt, startMs, endMs))))
    .map((t): MyDayTaskItem => ({
      ...t,
      ...(sharedIds.has(t.listId) ? { shared: true } : {}),
    }))
    .sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority)
      return pr !== 0 ? pr : a.title.localeCompare(b.title)
    })

  const events = input.events
    .filter((e) => e.startAt != null && inWindow(e.startAt, startMs, endMs))
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
