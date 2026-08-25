// Pure, display-only helpers for the Planner Diary tab. Kept out of the React
// component so the mood-field resolution, entry ordering and value labelling
// are unit-testable (no React/DOM, UTC-deterministic dates).

import type { DiaryEntryDto, FieldDefDto } from './api.js'
import { fmtTime, localYmd } from './planner-helpers.js'

// The label of the auto-seeded mood field (kept in lockstep with the BFF
// constant MOOD_FIELD_LABEL in apps/planner-api/src/routes/diary.ts).
export const MOOD_FIELD_LABEL = 'Mood'

// The seeded Mood field (a single_select labelled "Mood"), or null if absent
// (e.g. the user deleted it). The diary composer renders a dedicated picker for
// it and treats every other field as a generic data point.
export function findMoodField(defs: readonly FieldDefDto[]): FieldDefDto | null {
  return defs.find((d) => d.label === MOOD_FIELD_LABEL && d.fieldType === 'single_select') ?? null
}

// The user-defined "data point" fields (everything except the Mood field), in
// stable position order.
export function dataPointFields(defs: readonly FieldDefDto[]): FieldDefDto[] {
  const mood = findMoodField(defs)
  return defs
    .filter((d) => d.id !== mood?.id)
    .slice()
    .sort((a, b) => a.position - b.position)
}

// Entries newest-first by entry day, then within a day: day-only entries
// first (the all-day convention), timed entries by their instant newest-first,
// createdAt as the final tiebreak. The day is derived the same way the cards
// display it (ymdFromDueDate — LOCAL day for timed entries): comparing raw
// dueDate strings would rank a west-of-UTC late-evening entry (whose UTC
// instant crosses into the next calendar day) above the following day's
// day-only entries, contradicting its own day heading. Undated entries sink
// below dated ones.
export function sortDiaryEntries(entries: readonly DiaryEntryDto[]): DiaryEntryDto[] {
  return entries.slice().sort((a, b) => {
    const dayA = ymdFromDueDate(a.dueDate)
    const dayB = ymdFromDueDate(b.dueDate)
    if (dayA !== dayB) {
      if (!dayA) return 1
      if (!dayB) return -1
      return dayA < dayB ? 1 : -1
    }
    const timedA = dayA !== '' && !isDayOnlyDueDate(a.dueDate)
    const timedB = dayB !== '' && !isDayOnlyDueDate(b.dueDate)
    if (timedA !== timedB) return timedA ? 1 : -1
    if (timedA && timedB) {
      // Epoch comparison rather than string comparison: lexicographic order
      // only matches instant order for same-width ISO strings, and nothing
      // guarantees a future producer keeps the .toISOString() shape.
      const tA = new Date(a.dueDate as string).getTime()
      const tB = new Date(b.dueDate as string).getTime()
      if (tA !== tB && !Number.isNaN(tA) && !Number.isNaN(tB)) return tA < tB ? 1 : -1
    }
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  })
}

// Resolve a stored select value (a choice id) to its display label.
export function choiceLabel(field: FieldDefDto | null | undefined, value: unknown): string | null {
  if (!field || value == null || value === '') return null
  const found = (field.options.choices ?? []).find((c) => c.id === value)
  return found ? found.label : null
}

// A field's stored value as a display string for an entry chip, or null when
// there is nothing worth showing. Selects resolve choice ids to labels (a
// multi_select value may be an array of ids); a checkbox shows only when ticked.
export function formatFieldValue(def: FieldDefDto, raw: unknown): string | null {
  if (raw == null || raw === '') return null
  if (def.fieldType === 'single_select') return choiceLabel(def, raw)
  if (def.fieldType === 'multi_select') {
    const ids = Array.isArray(raw) ? raw : [raw]
    const labels = ids.map((id) => choiceLabel(def, id)).filter((l): l is string => l != null)
    return labels.length ? labels.join(', ') : null
  }
  if (def.fieldType === 'checkbox') return raw === true ? 'Yes' : null
  return String(raw)
}

// Day-only vs timed split for a stored diary dueDate. Day-only entries are
// stored as exactly midnight-UTC: the composers send the raw 'YYYY-MM-DD'
// string, which the BFF normalizes to '…T00:00:00.000Z' (and an optimistic
// outbox row still carries the raw date until the flush reconciles it).
// Anything else was written with an explicit time via combineDueDateTime and
// is a true instant, interpreted in the viewer's local zone. A timed entry
// landing on exactly UTC midnight reads as day-only — a rare, accepted edge.
export function isDayOnlyDueDate(dueDate: string | null): boolean {
  if (!dueDate) return true
  if (!dueDate.includes('T')) return true
  return /T00:00:00(?:\.000)?Z$/.test(dueDate)
}

// 'YYYY-MM-DD' for a stored dueDate. Day-only entries slice the UTC date part
// (round-trips the raw date string the composer sent); timed entries resolve
// to the LOCAL calendar day — slicing their UTC string would shift an evening
// entry onto the wrong day for west-of-UTC users.
export function ymdFromDueDate(dueDate: string | null): string {
  if (!dueDate) return ''
  if (isDayOnlyDueDate(dueDate)) return dueDate.slice(0, 10)
  const d = new Date(dueDate)
  return Number.isNaN(d.getTime()) ? dueDate.slice(0, 10) : localYmd(dueDate)
}

// Local 12-hour time label for a timed entry ("8:42 PM"), null for day-only /
// missing dues so the card renders nothing rather than a fake "12:00 AM".
export function entryTimeLabel(dueDate: string | null): string | null {
  if (isDayOnlyDueDate(dueDate)) return null
  return fmtTime(dueDate) || null
}

// "Fri, Jun 13, 2026" for an entry's day. Formatted in UTC so the heading
// matches the chosen day regardless of the viewer's timezone.
export function formatEntryDate(ymd: string): string {
  if (!ymd) return 'No date'
  const [y, m, d] = ymd.split('-').map(Number)
  // A malformed ymd (wrong segment count) leaves y as undefined; fall back to
  // NaN so Date.UTC produces an Invalid Date, caught by the isNaN check below.
  const date = new Date(Date.UTC(y ?? NaN, (m ?? 1) - 1, d ?? 1))
  if (Number.isNaN(date.getTime())) return ymd
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
