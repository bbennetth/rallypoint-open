// Pure helpers for the Events surface. Extracted from EventsPage.tsx so they
// can be unit-tested without a DOM.

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
