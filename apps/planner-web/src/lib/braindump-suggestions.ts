// Pure glue between a brain-dump enrichment's task/event suggestions and the
// existing create paths (createTaskItem / createPersonalEvent). Suggestions
// are confirm-first: nothing is created until the user taps a chip. Kept out
// of the component so the mapping + confirmed-state bookkeeping are
// unit-tested (no React/DOM). Mirrors assist-helpers' save mapping.

import type {
  BraindumpEnrichment,
  BraindumpEventSuggestion,
  BraindumpTaskSuggestion,
} from './api.js'
import type { EventCreateFields } from './assist-helpers.js'

// createTaskItem(listId, title, opts) opts for a suggested task.
export function suggestedTaskOpts(s: BraindumpTaskSuggestion): { dueDate?: string | null } {
  return s.dueDate ? { dueDate: s.dueDate } : {}
}

// createPersonalEvent fields for a suggested event. Enrichment coercion only
// emits suggestions with a resolvable startAt, but stay defensive: a null
// startAt maps to an all-day event with no date fields (the create form
// would reject it, so callers should filter with hasSchedulableStart first).
export function suggestedEventFields(s: BraindumpEventSuggestion): EventCreateFields {
  return {
    name: s.title,
    allDay: s.allDay,
    ...(s.startAt ? { startAt: s.startAt } : {}),
    ...(s.endAt ? { endAt: s.endAt } : {}),
  }
}

export function hasSchedulableStart(s: BraindumpEventSuggestion): boolean {
  return s.startAt !== null
}

// Stable keys for per-suggestion confirmed/dismissed UI state.
export function taskSuggestionKey(s: BraindumpTaskSuggestion, index: number): string {
  return `task:${index}:${s.title}`
}

export function eventSuggestionKey(s: BraindumpEventSuggestion, index: number): string {
  return `event:${index}:${s.title}`
}

// True when the enrichment carries anything to offer.
export function hasSuggestions(
  e: Pick<BraindumpEnrichment, 'taskSuggestions' | 'eventSuggestions'>,
): boolean {
  return e.taskSuggestions.length > 0 || e.eventSuggestions.filter(hasSchedulableStart).length > 0
}
