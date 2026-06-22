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

export type UpcomingItem =
  | { kind: 'task'; task: ListItemDto }
  | { kind: 'event'; event: PersonalEventDto }
  | { kind: 'eventDay'; eventDay: EventDayItem }

export interface Upcoming {
  date: string
  timezone: string
  dated: UpcomingItem[] // has a date >= start of today, soonest first
  undated: UpcomingItem[] // no date, by creation then title
}

// How many future occurrences of one recurring series appear in Upcoming.
// Series are materialized weeks ahead (rolling window, up to 50 instances);
// showing them all turns the feed into a wall of "Laundry" rows. The next
// two are enough to see "today/this week and the one after".
export const SERIES_OCCURRENCE_CAP = 2

// Keep only the first `cap` occurrences of each recurring series in an
// already-sorted dated stream (soonest first, so "first" = "next due").
// Non-series items pass through untouched. Pure; does not mutate the input.
export function capSeriesOccurrences(dated: UpcomingItem[], cap: number): UpcomingItem[] {
  const seen = new Map<string, number>()
  return dated.filter((i) => {
    if (i.kind !== 'task' || i.task.seriesId == null) return true
    const n = seen.get(i.task.seriesId) ?? 0
    if (n >= cap) return false
    seen.set(i.task.seriesId, n + 1)
    return true
  })
}

const DAY_MS = 86_400_000

// Whether any part of a personal event lands at/after the forward window start
// (`fromMs`) — i.e. the event still has a day to show in the feed. Mirrors the
// My Day overlap rule: a timed event uses its real end instant; an all-day
// event's endAt is local midnight of its inclusive last day, so +DAY_MS keeps
// that final day in range; a point event (no usable endAt) falls back to its
// start instant (the old "startAt ≥ window start" behaviour).
function eventReachesForward(e: PersonalEventDto, fromMs: number): boolean {
  if (e.startAt == null) return false
  const s = Date.parse(e.startAt)
  if (!Number.isFinite(s)) return false
  const rawEnd = e.endAt != null ? Date.parse(e.endAt) : NaN
  const hasEnd = Number.isFinite(rawEnd) && rawEnd > s
  const endEff = hasEnd ? (e.allDay ? rawEnd + DAY_MS : rawEnd) : s
  return endEff >= fromMs
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
  /** Group event ids that should be marked shared in the output (planner-flagged). */
  sharedEventIds?: readonly string[]
}): Upcoming {
  const fromMs = Date.parse(input.fromInstant)
  const tz = input.timezone
  const sharedEventIds = new Set(input.sharedEventIds ?? [])

  const items: UpcomingItem[] = [
    ...input.tasks.map((task): UpcomingItem => ({ kind: 'task', task })),
    ...input.events.map((event): UpcomingItem => ({ kind: 'event', event })),
    ...expandEventDays(input.userEvents, sharedEventIds).map(
      (eventDay): UpcomingItem => ({ kind: 'eventDay', eventDay }),
    ),
  ]

  const dated: UpcomingItem[] = []
  const undated: UpcomingItem[] = []
  for (const i of items) {
    // Events keep their place in the forward feed if any part of them is still
    // at/after the window start — so a multi-day event that STARTED before today
    // but runs into it (or beyond) isn't dropped as "past". The client expands
    // it across the days it still covers; here we only decide inclusion. Tasks
    // and group event-days keep the simple "instant ≥ window start" rule.
    if (i.kind === 'event') {
      if (i.event.startAt == null) {
        undated.push(i)
        continue
      }
      if (eventReachesForward(i.event, fromMs)) dated.push(i)
      continue
    }
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

  return {
    date: input.date,
    timezone: input.timezone,
    dated: capSeriesOccurrences(dated, SERIES_OCCURRENCE_CAP),
    undated,
  }
}
