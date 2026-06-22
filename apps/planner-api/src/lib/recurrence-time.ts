import type { ListItemDto } from '@rallypoint/lists-client'
import { dayInstant } from './day-window.js'

// Recurring occurrences carry a FLOATING local wall-clock due, not an absolute
// instant. lists-api materializes them server-side with no timezone, so
// occurrenceDueDate stamps `${occurrenceDate}T${timeOfDay}Z` — the UTC
// components ARE the intended local time. A daily "Pills at 10:30" therefore
// means 10:30 in the viewer's OWN zone (alarm-clock semantics), matching how a
// one-off task due is anchored to local midnight client-side. Reading that
// UTC-stamped instant back in a non-UTC zone is what shifted 10:30 → 3:30 (a
// −7h Pacific offset); the same skew can push an early-morning occurrence onto
// the wrong calendar day.
//
// Resolve each series-backed due to a real instant in the request `tz` so the
// day window AND the client's local rendering line up. One-off items (seriesId
// null) carry a genuine absolute instant and pass through untouched. A no-time
// occurrence (stamped `T00:00:00Z`) resolves to local midnight in `tz` — the
// same all-day anchor one-off date-only dues use; the client requests its own
// runtime zone, so it reads that instant back at local midnight and keeps it in
// the all-day bucket (planner-helpers `hasTimeOfDay`), now landed on the right
// calendar day instead of the prior raw `T00:00Z` (a day early west of UTC).

// Captures the date + wall-clock from a floating due (`YYYY-MM-DDThh:mm[:ss]…`).
const FLOATING_DUE_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)/

// Reinterpret one floating due's wall-clock as local time in `tz`. Returns the
// input unchanged if it doesn't parse as a floating due (defensive).
export function resolveFloatingDue(dueDate: string, tz: string): string {
  const m = FLOATING_DUE_RE.exec(dueDate)
  if (!m) return dueDate
  return dayInstant(m[1]!, m[2]!, tz)
}

// Map a task list, resolving every recurring item's floating due into `tz`.
// Pure; returns a new array and copies only the items it rewrites.
export function resolveRecurrenceDues(tasks: ListItemDto[], tz: string): ListItemDto[] {
  return tasks.map((t) =>
    t.seriesId != null && t.dueDate != null
      ? { ...t, dueDate: resolveFloatingDue(t.dueDate, tz) }
      : t,
  )
}
