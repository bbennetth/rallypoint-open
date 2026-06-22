// Pure helpers for the standalone Calendar surface. Kept out of the page
// component so the merge + window math is unit-testable without a DOM.
// No React, no globals, no fetches.

import type { UpcomingGroup } from './planner-helpers.js'

// The calendar view modes the standalone Calendar exposes. The list/agenda view
// stays on My Day / Events — the calendar is week + month only.
export type CalendarView = 'week' | 'month'

// Merge any number of UpcomingGroup[] sources into one set of day-groups, keyed
// by ymd. Items from earlier sources keep their position ahead of items from
// later sources on the same day, so the caller controls intra-day ordering
// (e.g. tasks + event-days, then personal events, then holidays). The result is
// sorted ascending by ymd. Pure — never mutates the inputs.
export function mergeCalendarGroups(...sources: UpcomingGroup[][]): UpcomingGroup[] {
  const byYmd = new Map<string, UpcomingGroup>()
  for (const groups of sources) {
    for (const g of groups) {
      const existing = byYmd.get(g.ymd)
      if (existing) {
        existing.items.push(...g.items)
      } else {
        // Clone so we never mutate a caller's group object or its items array.
        byYmd.set(g.ymd, { ...g, items: [...g.items] })
      }
    }
  }
  return Array.from(byYmd.values()).sort((a, b) =>
    a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0,
  )
}

// Derive the {from,to} YYYY-MM-DD window the visible calendar covers, used to
// fetch holidays for exactly the days on screen. Month view spans the 1st → last
// day of the month; week view spans the Sunday→Saturday week containing the
// anchor day. weekStart is fixed to Sunday, matching the calendar grid.
export function calendarWindow(
  view: CalendarView,
  calYear: number,
  calMonth: number,
  weekAnchor: string,
): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0')
  if (view === 'month') {
    // new Date(year, month, 0) is the last day of `month` (month is 1-based here).
    const lastDay = new Date(calYear, calMonth, 0).getDate()
    return {
      from: `${calYear}-${pad(calMonth)}-01`,
      to: `${calYear}-${pad(calMonth)}-${pad(lastDay)}`,
    }
  }
  // week: walk back to the Sunday that starts the anchor's week, then +6 days.
  const [y, mo, d] = weekAnchor.split('-').map(Number)
  const dow = new Date(y!, (mo ?? 1) - 1, d ?? 1).getDay() // 0=Sun … 6=Sat
  const start = new Date(y!, (mo ?? 1) - 1, (d ?? 1) - dow)
  const end = new Date(y!, (mo ?? 1) - 1, (d ?? 1) - dow + 6)
  const fmt = (dt: Date) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
  return { from: fmt(start), to: fmt(end) }
}
