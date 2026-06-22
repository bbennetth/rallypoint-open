// Display helpers for event dates.
//
// An event's `start_date` / `end_date` are bare 'YYYY-MM-DD' calendar dates
// (no time, no zone) — the day the event happens, the same day for every
// viewer. The naive `new Date('2026-06-12').toLocaleDateString()` parses the
// bare string as UTC midnight and then prints it in the viewer's LOCAL zone,
// so anyone west of UTC sees the previous day ("Jun 11" for a Jun 12 event).
//
// Building the Date from explicit UTC parts and pinning the format to
// `timeZone: 'UTC'` shows the entered calendar date everywhere — the same
// pattern the planner's diary / recurrence-label helpers already use. A full
// ISO instant is accepted too (its date part is used verbatim).
export function formatEventDay(
  date: string | null,
  style: 'medium' | 'long' = 'long',
): string {
  if (!date) return '—'
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return '—'
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString(undefined, { dateStyle: style, timeZone: 'UTC' })
}
