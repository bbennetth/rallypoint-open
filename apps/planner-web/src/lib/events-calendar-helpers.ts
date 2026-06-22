// Pure helpers for rendering PersonalEventDto[] in the CalendarView
// (MonthGrid / WeekStrip). These are separate from planner-helpers.ts because
// they own the Events-tab adapter concern: mapping PersonalEventDto →
// UpcomingGroup[] so the calendar components can be reused without forking.
//
// All functions are pure (no React, no globals, no fetches) so they can be
// unit-tested with vitest without a DOM.

import type { HolidayDto, PersonalEventDto, UpcomingItem } from './api.js'
import type { UpcomingGroup } from './planner-helpers.js'
import { groupDateLabel, localYmd, relativeDayLabel } from './planner-helpers.js'

// The event-projection arm of the UpcomingItem union (what the calendar chips +
// the Coming up feed carry). Both PersonalEventDto and this projection satisfy
// the minimal {startAt,endAt,allDay} shape eventSpanYmds needs.
type EventUpcomingItem = Extract<UpcomingItem, { kind: 'event' }>

// Cap on how many day-cells a single event may occupy. Guards the calendar grid
// and the Coming up feed against a pathological or bad-data range (e.g. an event
// accidentally set years long) blowing up the render.
export const MAX_EVENT_SPAN_DAYS = 60

// Add `delta` calendar days to a YYYY-MM-DD using the local-time constructor, so
// DST-jump days still yield the right calendar date (no UTC drift on the parts).
function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y!, (m ?? 1) - 1, (d ?? 1) + delta)
  const mo = String(dt.getMonth() + 1).padStart(2, '0')
  const da = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mo}-${da}`
}

// The local calendar days (YYYY-MM-DD, ascending) a personal event occupies.
//
// Single-day or end-less events → [startDay]. Multi-day events list every day
// from their start day through their end day inclusive, so a 3-day event shows
// on all three days rather than only the first.
//
// End semantics follow how the Planner editor stores them (PersonalEventEdit):
//   - all-day: endAt is LOCAL MIDNIGHT of the last day the event covers, so the
//     last day is localYmd(endAt) and it is INCLUSIVE.
//   - timed: endAt is the real end instant, so a timed event ending exactly at
//     local midnight does NOT occupy that final day (half-open) — an 8pm→midnight
//     event is a single day.
// Bad ranges (endAt <= startAt) collapse to [startDay]; the span is capped at
// MAX_EVENT_SPAN_DAYS. Events with no startAt have no calendar position → [].
export function eventSpanYmds(ev: {
  startAt: string | null
  endAt: string | null
  allDay: boolean
}): string[] {
  if (!ev.startAt) return []
  const startDay = localYmd(ev.startAt)
  if (!ev.endAt) return [startDay]
  const startMs = Date.parse(ev.startAt)
  const endMs = Date.parse(ev.endAt)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [startDay]

  let endDay = localYmd(ev.endAt)
  if (!ev.allDay) {
    const d = new Date(ev.endAt)
    const atLocalMidnight =
      d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0
    if (atLocalMidnight && endDay > startDay) endDay = addDaysYmd(endDay, -1)
  }
  if (endDay <= startDay) return [startDay]

  const days = [startDay]
  let cur = startDay
  while (cur < endDay && days.length < MAX_EVENT_SPAN_DAYS) {
    cur = addDaysYmd(cur, 1)
    days.push(cur)
  }
  return days
}

// What a calendar chip click resolves to on the Events tab: an event (looked
// up to its full PersonalEventDto so the detail drawer has every field) or a
// holiday (read-only). Task / eventDay chips have no detail surface here.
export type CalendarDetail =
  | { kind: 'event'; event: PersonalEventDto }
  | { kind: 'holiday'; holiday: HolidayDto }

// Map an UpcomingItem from a calendar chip click to its detail target.
//   - 'event'   → the matching PersonalEventDto from `events` (null if absent —
//                 the calendar item only carries a MyDayEvent projection, so we
//                 re-hydrate the full DTO the drawer + ticket panel need).
//   - 'holiday' → the wrapped HolidayDto (shown read-only, no edit).
//   - other     → null (tasks/eventDays don't appear on the Events calendar).
// Pure: no React, no globals — unit-tested without a DOM.
export function resolveCalendarDetail(
  item: UpcomingItem,
  events: PersonalEventDto[],
): CalendarDetail | null {
  if (item.kind === 'holiday') return { kind: 'holiday', holiday: item.holiday }
  if (item.kind === 'event') {
    const event = events.find((e) => e.id === item.event.id)
    return event ? { kind: 'event', event } : null
  }
  return null
}

// Adapt a PersonalEventDto to the MyDayEvent shape that the UpcomingItem
// union wraps. Only the fields the calendar chip + item-click handler read are
// included; the rest (ticketCount, ticketPlatform, etc.) carry safe defaults.
function toUpcomingItem(ev: PersonalEventDto): EventUpcomingItem {
  return {
    kind: 'event',
    event: {
      id: ev.id,
      name: ev.name,
      startAt: ev.startAt,
      endAt: ev.endAt,
      allDay: ev.allDay,
      locationLabel: ev.locationLabel,
      ticketCount: ev.ticketCount,
      ticketPlatform: ev.ticketPlatform,
      ticketAccountEmail: ev.ticketAccountEmail,
    },
  }
}

// Return the calendar day (YYYY-MM-DD) an event belongs to.
// All-day events have no meaningful local-time: they store either a date-only
// startAt ("2026-06-15") or an ISO instant at midnight. We derive the local day
// from startAt regardless, which is correct for both formats (localYmd handles
// instant→local-calendar, and a bare date string parses as UTC midnight which
// localYmd maps to the same or ±1 day in extreme TZs — acceptable for calendar
// placement). Events with no startAt have no calendar position and are excluded.
export function eventYmd(ev: PersonalEventDto): string | null {
  if (!ev.startAt) return null
  return localYmd(ev.startAt)
}

// Group already-projected event items by every local calendar day they span
// (eventSpanYmds), so a multi-day event lands in each day it covers — not just
// its first. Items with no startAt (no calendar position) are skipped. The
// returned group array isn't globally date-sorted (an early long event seeds
// later days before a subsequent short event's day): both callers are
// order-insensitive — the calendar grid looks groups up by ymd, and the feed
// re-sorts via mergeCalendarGroups. Pure.
export function spannedEventGroups(
  items: EventUpcomingItem[],
  todayYmd: string,
): UpcomingGroup[] {
  const groups: UpcomingGroup[] = []
  const byYmd = new Map<string, UpcomingGroup>()

  for (const item of items) {
    for (const ymd of eventSpanYmds(item.event)) {
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
      g.items.push(item)
    }
  }

  return groups
}

// Convert a list of PersonalEventDtos into the UpcomingGroup[] shape that
// MonthGrid and WeekStrip expect. Events with no startAt are excluded (they
// can't be placed on a calendar cell). A multi-day event is placed on every day
// it spans (eventSpanYmds), so it shows in each cell rather than only the first.
export function personalEventsToGroups(
  events: PersonalEventDto[],
  todayYmd: string,
): UpcomingGroup[] {
  return spannedEventGroups(events.map(toUpcomingItem), todayYmd)
}
