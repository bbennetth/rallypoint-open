// Pure, display-only helpers for the Planner Diary tab. Kept out of the React
// component so the mood-field resolution, entry ordering and value labelling
// are unit-testable (no React/DOM, UTC-deterministic dates).

import type { DiaryEntryDto, FieldDefDto } from './api.js'

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

// Entries newest-first by entry day (dueDate), then createdAt as a tiebreak.
// Undated entries sink below dated ones.
export function sortDiaryEntries(entries: readonly DiaryEntryDto[]): DiaryEntryDto[] {
  return entries.slice().sort((a, b) => {
    if (a.dueDate && b.dueDate) {
      if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? 1 : -1
    } else if (a.dueDate) return -1
    else if (b.dueDate) return 1
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

// 'YYYY-MM-DD' for a stored dueDate (midnight-UTC ISO). The diary sends the
// raw date string on write, so slicing the UTC date part round-trips exactly.
export function ymdFromDueDate(dueDate: string | null): string {
  return dueDate ? dueDate.slice(0, 10) : ''
}

// "Fri, Jun 13, 2026" for an entry's day. Formatted in UTC so the heading
// matches the chosen day regardless of the viewer's timezone.
export function formatEntryDate(ymd: string): string {
  if (!ymd) return 'No date'
  const [y, m, d] = ymd.split('-').map(Number)
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
  if (Number.isNaN(date.getTime())) return ymd
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
