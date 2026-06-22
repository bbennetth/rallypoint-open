// Pure builder that turns the SeriesEdit form state + the original series
// into a sparse PATCH body (only changed fields) — kept out of the React
// component so the clearing/termination semantics are unit-testable.
//
// The server's rule schema has sharp edges this encodes:
//  - `until` must be a valid date or null; '' is rejected → clear with null.
//  - `count` is ignored when omitted → clear with null.
//  - `byDay` must have ≥1 entry or be null; [] is rejected → use null to
//    clear (daily, or weekly with no specific days = "dtstart's weekday").
//  - until/count are mutually exclusive.

import type { TaskSeriesDto, UpdateTaskSeriesInput } from './api.js'

export type TermMode = 'none' | 'until' | 'count'

export interface SeriesFormState {
  title: string
  notes: string
  priority: string | null
  freq: 'daily' | 'weekly'
  interval: string // raw input value
  byDay: string[]
  dtstart: string
  timeOfDay: string
  mode: TermMode
  untilDate: string
  countStr: string
}

export type BuildSeriesPatchResult =
  | { ok: true; patch: UpdateTaskSeriesInput }
  | { ok: false; error: string }

function sortedDays(days: string[]): string[] {
  return [...days].sort()
}

function daysEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((d, i) => d === b[i])
}

export function buildSeriesPatch(
  series: TaskSeriesDto,
  f: SeriesFormState,
): BuildSeriesPatchResult {
  const title = f.title.trim()
  if (!title) return { ok: false, error: 'Title is required.' }

  const patch: UpdateTaskSeriesInput = {}

  if (title !== series.title) patch.title = title

  // notes/timeOfDay: server normalizes '' → null, so '' is a valid clear.
  const notesVal = f.notes.trim()
  if (notesVal !== (series.notes ?? '')) patch.notes = notesVal

  // Priority is set-only for series: the rule schema treats priority as a
  // non-nullable enum, so clearing is not supported at the series level.
  // PriorityPicker may emit null (allowClear callers), but the truthiness guard
  // here is intentional and load-bearing — null falls through untouched.
  if (f.priority && f.priority !== series.priority) {
    patch.priority = f.priority
  }

  if (f.freq !== series.freq) patch.freq = f.freq

  const intervalNum = Math.max(1, parseInt(f.interval, 10) || 1)
  if (intervalNum !== series.interval) patch.interval = intervalNum

  // byDay: weekly with ≥1 selected day → the (sorted) array; otherwise null.
  const newDays = f.freq === 'weekly' && f.byDay.length > 0 ? sortedDays(f.byDay) : null
  const origDays = series.byDay && series.byDay.length > 0 ? sortedDays(series.byDay) : null
  if (!daysEqual(newDays, origDays)) patch.byDay = newDays

  if (f.dtstart && f.dtstart !== series.dtstart.slice(0, 10)) patch.dtstart = f.dtstart

  const timeVal = f.timeOfDay.trim()
  if (timeVal !== (series.timeOfDay ?? '')) patch.timeOfDay = timeVal

  // termination — until/count mutually exclusive; clear the other with null.
  if (f.mode === 'none') {
    if (series.until != null) patch.until = null
    if (series.count != null) patch.count = null
  } else if (f.mode === 'until') {
    if (!f.untilDate) return { ok: false, error: 'Pick an end date, or choose Never.' }
    if (f.untilDate !== (series.until ?? '')) patch.until = f.untilDate
    if (series.count != null) patch.count = null
  } else {
    const countNum = parseInt(f.countStr, 10)
    if (Number.isNaN(countNum) || countNum < 1) {
      return { ok: false, error: 'Enter how many times it repeats.' }
    }
    if (countNum !== series.count) patch.count = countNum
    if (series.until != null) patch.until = null
  }

  return { ok: true, patch }
}
