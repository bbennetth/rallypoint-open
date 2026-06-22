// Pure helpers for the Holidays settings surface (#548). Kept out of React
// components so they can be unit-tested without a DOM.

import type { HolidayDto, PersonalEventDto, UpcomingItem } from './api.js'
import {
  groupDateLabel,
  groupUpcomingByDay,
  relativeDayLabel,
  splitAgendaGroups,
} from './planner-helpers.js'
import type { UpcomingGroup } from './planner-helpers.js'
import { mergeCalendarGroups } from './calendar-merge-helpers.js'
import { eventYmd, spannedEventGroups } from './events-calendar-helpers.js'

// Read the holidays master toggle from a planner settings blob.
// Absent → true (ON by default); only an explicit `false` turns it off.
export function holidaysEnabled(settings: Record<string, unknown>): boolean {
  return settings.holidaysEnabled !== false
}

// Read the hidden holiday ids list from a planner settings blob.
export function hiddenHolidays(settings: Record<string, unknown>): string[] {
  const v = settings.hiddenHolidays
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

// Adapt a list of HolidayDtos into UpcomingGroup[] so they can be passed
// to MonthGrid / WeekStrip alongside personal event groups.
// Each holiday occupies its own group (by observedDate); groups with the
// same observedDate are merged into a single group (rare, but defensive).
export function holidaysToGroups(
  holidays: HolidayDto[],
  todayYmd: string,
): UpcomingGroup[] {
  const groups: UpcomingGroup[] = []
  const byYmd = new Map<string, UpcomingGroup>()

  for (const h of holidays) {
    const ymd = h.observedDate
    let g = byYmd.get(ymd)
    if (!g) {
      g = {
        ymd,
        dateLabel: groupDateLabel(ymd),
        rel: relativeDayLabel(ymd, todayYmd),
        items: [],
      }
      byYmd.set(ymd, g)
      groups.push(g)
    }
    g.items.push({ kind: 'holiday', holiday: h })
  }

  return groups
}

// Holidays whose observedDate is exactly `ymd` (the local calendar day). Used
// to surface today's holiday(s) in the My Day roll-up's all-day band. Pure.
export function holidaysOnDay(holidays: HolidayDto[], ymd: string): HolidayDto[] {
  return holidays.filter((h) => h.observedDate === ymd)
}

// Build the "Coming up" feed's day-groups: the forward-looking Upcoming items
// merged with holidays, keeping only strictly-future days. Today's items already
// live in the My Day roll-up above the feed (so they'd double up here) —
// splitAgendaGroups(...).future drops the today/overdue buckets, matching the
// feed's existing behaviour.
//
// Events are grouped separately via spannedEventGroups so a multi-day event
// appears under every day it covers (not just its start day); tasks/eventDays
// keep their single-day grouping. Events are passed AFTER the task/eventDay base
// (mergeCalendarGroups appends later sources within a day) so a day reads
// tasks → events → holidays, matching the calendar + Events list ordering. Pure
// — reuses the already-tested grouping/merge helpers.
export function upcomingFeedGroups(
  dated: UpcomingItem[],
  holidays: HolidayDto[],
  todayYmd: string,
): UpcomingGroup[] {
  const eventItems = dated.filter(
    (it): it is Extract<UpcomingItem, { kind: 'event' }> => it.kind === 'event',
  )
  const nonEvents = dated.filter((it) => it.kind !== 'event')
  const base = groupUpcomingByDay(nonEvents, todayYmd)
  const events = spannedEventGroups(eventItems, todayYmd)
  const merged = mergeCalendarGroups(base, events, holidaysToGroups(holidays, todayYmd))
  return splitAgendaGroups(merged, todayYmd).future
}

// A single row in the Events-tab LIST view: a personal event or a holiday.
// The list interleaves both kinds chronologically so they render as one
// uniform list (rather than holidays in a separate block above the events).
export type EventsListRow =
  | { kind: 'event'; event: PersonalEventDto }
  | { kind: 'holiday'; holiday: HolidayDto }

// Merge personal events and holidays into one chronological row list for the
// Events LIST view. Ordering rules:
//   - Dated rows sort ascending by calendar day: an event by its local day
//     (eventYmd, same placement the calendar views use), a holiday by its
//     observedDate.
//   - Same-day ties put events before holidays (matching the calendar merge,
//     which appends holidays after a day's events).
//   - Events with no startAt have no calendar day; they keep the BFF order
//     they arrived in and sit at the end (preserving the old list behaviour).
// Pure + stable: events keep their incoming relative order, as do holidays.
export function mergeEventsAndHolidays(
  events: PersonalEventDto[],
  holidays: HolidayDto[],
): EventsListRow[] {
  const dated: { row: EventsListRow; ymd: string; rank: number }[] = []
  const undated: EventsListRow[] = []

  for (const event of events) {
    const ymd = eventYmd(event)
    if (ymd == null) undated.push({ kind: 'event', event })
    else dated.push({ row: { kind: 'event', event }, ymd, rank: 0 })
  }
  for (const holiday of holidays) {
    dated.push({ row: { kind: 'holiday', holiday }, ymd: holiday.observedDate, rank: 1 })
  }

  // Stable sort by (day, rank); Array.prototype.sort is stable in ES2019+, so
  // rows sharing a (ymd, rank) keep their input order.
  dated.sort((a, b) => (a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : a.rank - b.rank))

  return [...dated.map((d) => d.row), ...undated]
}
