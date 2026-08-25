// Pure helpers for the inline Plan builder (search → select → add to a
// day, plus moving items between days). Extracted from PlanPage so the
// selection→plan-item mapping and position math can be unit-tested
// without a DOM or the @dnd-kit runtime the Plan tab used to depend on.

import type {
  DayKey,
  PlanSourceKind,
  TrainingPlanItemDto,
  WodTemplateDto,
} from '@rallypoint/fitness-shared'

// Shared day-chip labels for the Mon→Sun pickers (Plan grid, composer
// schedule, WOD-drawer add-to-plan).
export const DAY_LABELS: Record<DayKey, string> = {
  mon: 'MON',
  tue: 'TUE',
  wed: 'WED',
  thu: 'THU',
  fri: 'FRI',
  sat: 'SAT',
  sun: 'SUN',
}

// A thing the user picked from the combined search and is about to drop
// on a day: a saved template (WOD or strength), a single catalog
// exercise, or a free-form standalone run (note-only, no sourceId).
export type PlanSelection =
  | { kind: 'template'; templateId: string; templateKind: 'wod' | 'strength'; name: string }
  | { kind: 'exercise'; exerciseId: string; name: string }
  | { kind: 'run'; name: string; note?: string | null }

// The (sourceKind, sourceId) a selection maps to when written as a plan
// item. Keeps the template-kind → source-kind mapping in one tested place
// (a strength template stored as a WOD would route to the wrong engine on
// Start — the bug the DnD path repeatedly hit). A run is note-only, so it
// carries no sourceId (the schema's superRefine rejects one).
export function selectionToItemSource(sel: PlanSelection): {
  sourceKind: PlanSourceKind
  sourceId: string | null
} {
  if (sel.kind === 'exercise') {
    return { sourceKind: 'exercise', sourceId: sel.exerciseId }
  }
  if (sel.kind === 'run') {
    return { sourceKind: 'run', sourceId: null }
  }
  return {
    sourceKind: sel.templateKind === 'strength' ? 'strength_template' : 'wod_template',
    sourceId: sel.templateId,
  }
}

// Next append position within a day = current item count (positions are
// dense 0..n-1 within a day; the server clamps out-of-range).
export function nextPositionInDay(
  items: TrainingPlanItemDto[],
  dayKey: DayKey,
): number {
  return items.filter((it) => it.dayKey === dayKey).length
}

// Whether a selection can currently be placed (an exercise/template is
// selected AND there's a plan to write to).
export function canPlace(
  selection: PlanSelection | null,
  planId: string | null,
): planId is string {
  return selection !== null && planId != null
}

// Filter a list of {name} by a lowercase query; empty query returns the
// whole list (capped by the caller). Shared by the workout + exercise
// search groups.
export function filterByName<T extends { name: string }>(
  list: T[],
  query: string,
  limit: number,
): T[] {
  const q = query.trim().toLowerCase()
  const matched = q ? list.filter((x) => x.name.toLowerCase().includes(q)) : list
  return matched.slice(0, limit)
}

// A saved template row → a PlanSelection (used when the user taps a
// workout search result).
export function templateToSelection(w: WodTemplateDto): PlanSelection {
  return {
    kind: 'template',
    templateId: w.id,
    templateKind: w.kind,
    name: w.name,
  }
}
