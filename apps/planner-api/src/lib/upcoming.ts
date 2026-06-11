import type { ListItemDto } from '@rallypoint/lists-client'
import type { PersonalEventDto, UserEventDto } from '@rallypoint/events-client'
import { dayInstant } from './day-window.js'
import { expandEventDays, isAllDay, type EventDayItem } from './event-days.js'

// Pure Upcoming composition: merge the actor's tasks and personal events into
// a single forward-looking stream. Items carrying a date at or after the start
// of the user's local day land in `dated` (soonest first); items with no date
// (a backlog task, an event with no start time) float into `undated`. Like
// composeMyDay this is the Planner BFF's own aggregation (modelled on
// events-api's group-day), not domain logic, so it lives here rather than in a
// shared SDK package.
//
// Boundary: only the lower bound matters — Upcoming is open-ended forward — so
// the caller passes the start of the local day (from day-window's
// zonedDayWindow). Items strictly before it are dropped (past), which means
// today's items are included (My Day and Upcoming intentionally overlap on
// today, the first row of the list).

// Task wrapper with optional shared marker. When `shared` is true the item
// came from a planner-flagged shared list (not the actor's personal scope).
export interface UpcomingTaskItem {
  kind: 'task'
  task: ListItemDto
  /** True when the task belongs to a planner-flagged shared list. */
  shared?: boolean
}

export type UpcomingItem =
  | UpcomingTaskItem
  | { kind: 'event'; event: PersonalEventDto }
  | { kind: 'eventDay'; eventDay: EventDayItem }

export interface Upcoming {
  date: string
  timezone: string
  dated: UpcomingItem[] // has a date >= start of today, soonest first
  undated: UpcomingItem[] // no date, by creation then title
}

// The instant an item buckets/sorts by. eventDays always carry a date, so they
// resolve via dayInstant in the client's tz (all-day → start of that day).
function itemInstant(i: UpcomingItem, tz: string): string | null {
  if (i.kind === 'task') return i.task.dueDate
  if (i.kind === 'event') return i.event.startAt
  return dayInstant(i.eventDay.date, i.eventDay.startTime, tz)
}

function itemLabel(i: UpcomingItem): string {
  if (i.kind === 'task') return i.task.title
  if (i.kind === 'event') return i.event.name
  return i.eventDay.name
}

function itemCreatedAt(i: UpcomingItem): string {
  if (i.kind === 'task') return i.task.createdAt
  if (i.kind === 'event') return i.event.createdAt
  // eventDays always have a date so they never reach the undated bucket; this
  // fallback keeps the helper total.
  return i.eventDay.date
}

// All-day group event days float above any timed item sharing their instant
// (a task, a personal event, or a timed event day) — the conventional "all-day
// banner on top of the day's schedule" ordering. An all-day day's instant is
// local midnight, so this tiebreaker only bites against an item that also lands
// exactly on midnight.
function allDayRank(i: UpcomingItem): number {
  return i.kind === 'eventDay' && isAllDay(i.eventDay) ? 0 : 1
}

export function composeUpcoming(input: {
  date: string
  timezone: string
  fromInstant: string // ISO — start of the local day in UTC
  tasks: ListItemDto[]
  events: PersonalEventDto[]
  userEvents: UserEventDto[] // group (festival) events, expanded per day
  /** List ids that should be marked shared in the output (planner-flagged). */
  sharedListIds?: readonly string[]
  /** Group event ids that should be marked shared in the output (planner-flagged). */
  sharedEventIds?: readonly string[]
}): Upcoming {
  const fromMs = Date.parse(input.fromInstant)
  const tz = input.timezone
  const sharedIds = new Set(input.sharedListIds ?? [])
  const sharedEventIds = new Set(input.sharedEventIds ?? [])

  const items: UpcomingItem[] = [
    ...input.tasks.map((task): UpcomingItem => ({
      kind: 'task',
      task,
      ...(sharedIds.has(task.listId) ? { shared: true } : {}),
    })),
    ...input.events.map((event): UpcomingItem => ({ kind: 'event', event })),
    ...expandEventDays(input.userEvents, sharedEventIds).map(
      (eventDay): UpcomingItem => ({ kind: 'eventDay', eventDay }),
    ),
  ]

  const dated: UpcomingItem[] = []
  const undated: UpcomingItem[] = []
  for (const i of items) {
    const instant = itemInstant(i, tz)
    if (instant == null) {
      undated.push(i)
      continue
    }
    const t = Date.parse(instant)
    if (Number.isFinite(t) && t >= fromMs) dated.push(i)
    // instants before the window start are past — dropped from both buckets.
  }

  dated.sort((a, b) => {
    const at = Date.parse(itemInstant(a, tz) as string)
    const bt = Date.parse(itemInstant(b, tz) as string)
    if (at !== bt) return at - bt
    const ar = allDayRank(a)
    const br = allDayRank(b)
    if (ar !== br) return ar - br
    return itemLabel(a).localeCompare(itemLabel(b))
  })

  undated.sort((a, b) => {
    const ac = itemCreatedAt(a)
    const bc = itemCreatedAt(b)
    return ac !== bc ? ac.localeCompare(bc) : itemLabel(a).localeCompare(itemLabel(b))
  })

  return { date: input.date, timezone: input.timezone, dated, undated }
}
