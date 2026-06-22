import type { CreateTaskSeriesInput } from './api.js'
import { SHOW_CHORES_IN_FEEDS_KEY } from './api.js'

// Pure decision helpers for the Chores surface (#546). Kept out of the React
// component so they can be unit-tested in isolation (no DOM).

export type ChoreFreq = 'daily' | 'weekly'
export type ChoreBound = 'count' | 'until' | 'forever'

export interface ChoreRecurrenceForm {
  title: string
  freq: ChoreFreq
  interval: number
  byDay: string[]
  dtstart: string
  bound: ChoreBound
  count: number
  until: string
  timeOfDay: string
}

// Build the CreateTaskSeriesInput from the recurrence form state, or return an
// error string when the form is invalid (e.g. an 'until' bound with no date).
// Mirrors the inline logic in TasksPage.onCreateItem so the two stay in lockstep
// while staying testable. byDay is weekly-only; an 'until' bound requires a date.
export function buildChoreSeriesInput(
  form: ChoreRecurrenceForm,
): { ok: true; input: CreateTaskSeriesInput } | { ok: false; error: string } {
  const title = form.title.trim()
  if (!title) return { ok: false, error: 'Enter a chore name.' }

  const input: CreateTaskSeriesInput = {
    title,
    freq: form.freq,
    interval: form.interval,
    dtstart: form.dtstart,
  }
  if (form.freq === 'weekly' && form.byDay.length > 0) input.byDay = form.byDay
  if (form.timeOfDay) input.timeOfDay = form.timeOfDay
  if (form.bound === 'count') input.count = form.count
  else if (form.bound === 'until') {
    if (!form.until) {
      return { ok: false, error: 'Pick an end date, or choose a different end condition.' }
    }
    input.until = form.until
  }
  return { ok: true, input }
}

// Pure read of the chores-in-feeds setting from a planner settings blob.
// Absent → true (ON by default); only an explicit `false` turns it off.
// Mirrors the server-side choresInFeedsEnabled so client + BFF agree.
export function choresInFeedsEnabled(settings: Record<string, unknown>): boolean {
  return settings[SHOW_CHORES_IN_FEEDS_KEY] !== false
}
