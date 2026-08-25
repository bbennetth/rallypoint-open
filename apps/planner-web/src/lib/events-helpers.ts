// Pure helpers for the Events surface. Extracted from EventsPage.tsx so they
// can be unit-tested without a DOM.

import { eventSpanYmds } from './events-calendar-helpers.js'

/**
 * Whether an event is over: the last local calendar day it covers is before
 * `todayYmd`. Day-based (not instant-based) so a timed event earlier today
 * stays visible until midnight, matching how the calendar and My Day place
 * events. Undated events (no startAt) are never past. Reuses eventSpanYmds,
 * which already handles all-day inclusive ends, timed midnight half-open
 * ends, multi-day spans and bad ranges.
 */
export function isPastEvent(
  ev: { startAt: string | null; endAt: string | null; allDay: boolean },
  todayYmd: string,
): boolean {
  const days = eventSpanYmds(ev)
  if (days.length === 0) return false
  return days[days.length - 1]! < todayYmd
}

/** Short status chip from an event's start instant. Returns null when undated. */
export function deriveStatus(startAt: string | null): 'PAST' | 'TODAY' | 'SOON' | 'UPCOMING' | null {
  if (!startAt) return null
  const ms = Date.parse(startAt)
  if (!Number.isFinite(ms)) return null
  const diff = ms - Date.now()
  if (diff < 0) return 'PAST'
  if (diff < 24 * 60 * 60 * 1000) return 'TODAY'
  if (diff < 7 * 24 * 60 * 60 * 1000) return 'SOON'
  return 'UPCOMING'
}

/**
 * Full date+time range label for the event detail card.
 * e.g. "Jun 12, 2026, 9:30 AM – 11:00 AM" or "Jun 12, 2026, 9:30 AM"
 * When allDay=true, shows date-only (no time component).
 */
export function formatWhen(startAt: string | null, endAt: string | null, allDay?: boolean): string {
  if (!startAt) return 'No date set'
  const start = new Date(startAt)
  if (allDay) {
    const dateStr = start.toLocaleDateString([], { dateStyle: 'medium' })
    if (!endAt) return dateStr
    const end = new Date(endAt)
    const endDateStr = end.toLocaleDateString([], { dateStyle: 'medium' })
    return `${dateStr} – ${endDateStr}`
  }
  const startStr = start.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  if (!endAt) return startStr
  const end = new Date(endAt)
  const endStr = end.toLocaleString([], { timeStyle: 'short' })
  return `${startStr} – ${endStr}`
}

/**
 * How the in-app ticket viewer should render an attachment. Browsers can
 * inline any raster image and (via <iframe>) PDFs; anything else gets a
 * download-only fallback. The accepted-upload list (useEventTickets
 * ACCEPTED_MIME) is a subset of image/* + PDF, so 'other' only shows up for
 * legacy/foreign rows.
 */
export function ticketViewKind(contentType: string): 'image' | 'pdf' | 'other' {
  if (/^image\//.test(contentType)) return 'image'
  if (contentType === 'application/pdf') return 'pdf'
  return 'other'
}

/**
 * Short date+time label for rail cards.
 * e.g. "Jun 12, 9:30 AM" or "Jun 12" (for all-day) or "No date"
 * When allDay=true, shows date only (no time).
 */
export function formatWhenShort(startAt: string | null, allDay?: boolean): string {
  if (!startAt) return 'No date'
  const d = new Date(startAt)
  if (Number.isNaN(d.getTime())) return 'No date'
  if (allDay) return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
