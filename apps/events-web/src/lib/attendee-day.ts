import type { DayDto } from './api.js'

// Pure day/agenda helpers shared by the attendee "Now" tab in both
// shells (group `/groups/:groupId/now`, solo `/events/:slug/attending/now`).
// Extracted from the former MyDayPage / SoloMyDayPage duplicates when the
// two tabs merged into one day-aware Now view.

export function todayIso(): string {
  // Local-date components, not toISOString() — otherwise users west of UTC
  // would default to tomorrow's date after UTC midnight.
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 'HH:MM:SS' → 'HH:MM'; pass through anything unexpected.
export function hm(time: string | null): string {
  if (!time) return ''
  const m = /^(\d{2}):(\d{2})/.exec(time)
  return m ? `${m[1]}:${m[2]}` : time
}

// Group an HH:MM:SS timestamp into an hour bucket like "14:00".
export function hourBucket(time: string | null): string {
  if (!time) return '—'
  const m = /^(\d{2}):/.exec(time)
  return m ? `${m[1]}:00` : '—'
}

export function labelForDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return d
    .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase()
}

// Which day the Now tab should open on: today when the event is running,
// otherwise its first day so the page doesn't render empty for someone
// opening it a week early. Falls back to today for events with no days
// published (the picker degrades to a free date input there).
export function defaultDateForEvent(
  days: readonly Pick<DayDto, 'date' | 'sort_order'>[],
  today: string,
): string {
  if (days.some((d) => d.date === today)) return today
  if (days.length === 0) return today
  const earliest = [...days].sort((a, b) => a.sort_order - b.sort_order)[0]!
  return earliest.date
}

export interface TimedRow {
  time: string | null
}

export interface HourGroup<T extends TimedRow> {
  hour: string
  rows: T[]
}

// Chronological agenda: sort by start time with untimed rows last, then
// collapse runs of the same hour into one labelled section. Sorting is
// stable, so rows sharing a time keep the caller's ordering.
export function buildHourGroups<T extends TimedRow>(rows: readonly T[]): HourGroup<T>[] {
  const sorted = [...rows].sort((a, b) =>
    (a.time ?? '99:99').localeCompare(b.time ?? '99:99'),
  )
  const groups: HourGroup<T>[] = []
  for (const row of sorted) {
    const hour = hourBucket(row.time)
    const last = groups[groups.length - 1]
    if (last && last.hour === hour) last.rows.push(row)
    else groups.push({ hour, rows: [row] })
  }
  return groups
}
