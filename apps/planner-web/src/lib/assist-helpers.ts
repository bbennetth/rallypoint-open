// Pure, testable glue between an AI Assist suggestion and the create/undo
// calls the AssistDrawer dispatches. Kept out of the component so category
// mapping, mood resolution, and the accepted-vs-edited verdict are unit-tested
// (no React/DOM). The async saves themselves live in the component.

import type {
  AssistCategory,
  AssistFoodItem,
  AssistSuggestion,
  CreateFitnessFoodLogInput,
  FieldDefDto,
} from './api.js'
import { localToday } from './planner-helpers.js'

export const ASSIST_CATEGORY_LABELS: Record<AssistCategory, string> = {
  task: 'Task',
  shopping: 'Shopping',
  event: 'Event',
  food: 'Food',
  note: 'Note',
  diary: 'Diary',
}

// 'food' is deliberately NOT offered as an edit-card chip target for
// non-food captures: switching a task into food would need macro
// estimation the client doesn't have. The card adds the Food chip only
// when the suggestion already carries items (see foodEditAllowed).
export const ASSIST_CATEGORIES: AssistCategory[] = ['task', 'shopping', 'event', 'note', 'diary']

// Map a 1..5 mood to the seeded Mood field's choice id. Choices are ordered
// worst→best (😞 Rough … 😄 Great), so mood N picks choice N-1. Returns null
// when there is no mood, no Mood field, or its choices don't line up.
export function moodChoiceId(field: FieldDefDto | null, mood: number | null): string | null {
  if (!field || mood == null) return null
  const choices = field.options.choices ?? []
  const idx = Math.min(5, Math.max(1, Math.round(mood))) - 1
  return choices[idx]?.id ?? null
}

// A diary entry always needs a day; fall back to the local today when the
// model didn't pin one.
export function diaryDueDate(
  suggestion: Pick<AssistSuggestion, 'dueDate'>,
  todayYmd: string = localToday().date,
): string {
  return suggestion.dueDate ?? todayYmd
}

// The task-create opts derived from a suggestion. Forwards both the resolved
// dueDate AND notes (the model can extract a supplementary detail — "call the
// dentist, ask about coverage" → title + notes), omitting each when empty.
export function taskCreateOpts(
  s: Pick<AssistSuggestion, 'dueDate' | 'notes'>,
): { dueDate?: string | null; notes?: string | null } {
  return {
    ...(s.dueDate ? { dueDate: s.dueDate } : {}),
    ...(s.notes ? { notes: s.notes } : {}),
  }
}

// The event-create fields derived from a suggestion.
export interface EventCreateFields {
  name: string
  allDay: boolean
  startAt?: string
  endAt?: string
  description?: string
}

export function eventCreateFields(s: AssistSuggestion): EventCreateFields {
  return {
    name: s.title,
    allDay: s.allDay,
    ...(s.startAt ? { startAt: s.startAt } : {}),
    ...(s.endAt ? { endAt: s.endAt } : {}),
    ...(s.notes ? { description: s.notes } : {}),
  }
}

// --- food (fitness diary cross-app save) -----------------------------

// One fitness food-log create body per suggested item. All items share one
// loggedAt (the save instant) and the scan's responseId, so the fitness-side
// trace links every row back to the assist call.
export function foodLogEntries(
  items: AssistFoodItem[],
  loggedAt: string,
  responseId: string,
): CreateFitnessFoodLogInput[] {
  return items.map((item) => ({
    loggedAt,
    name: item.name,
    quantityGrams: item.grams,
    kcal: item.kcal,
    proteinG: item.proteinG,
    carbsG: item.carbsG,
    fatG: item.fatG,
    source: 'text',
    ...(responseId ? { scanResponseId: responseId } : {}),
  }))
}

// Linear macro rescale when the user edits an item's grams (macros are TOTAL
// for the amount, so density is constant). Non-positive/absurd grams return
// the item unchanged — the caller keeps the field editable without letting
// the math blow up.
export function rescaleFoodItem(item: AssistFoodItem, grams: number): AssistFoodItem {
  if (!Number.isFinite(grams) || grams < 1 || grams > 5000 || item.grams <= 0) return item
  const f = grams / item.grams
  const r1 = (v: number) => Math.round(v * f * 10) / 10
  return {
    ...item,
    grams,
    kcal: Math.min(20000, Math.round(item.kcal * f)),
    proteinG: Math.min(2000, r1(item.proteinG)),
    carbsG: Math.min(2000, r1(item.carbsG)),
    fatG: Math.min(2000, r1(item.fatG)),
  }
}

// Toast line for a food save: "Cherries, ~25 kcal" / "3 foods, ~410 kcal".
export function foodToastLabel(items: AssistFoodItem[]): string {
  const kcal = Math.round(items.reduce((sum, i) => sum + i.kcal, 0))
  const what = items.length === 1 ? items[0]!.name : `${items.length} foods`
  return `${what}, ~${kcal} kcal`
}

// Food is a valid edit-card target only when there is something to log.
export function foodEditAllowed(s: Pick<AssistSuggestion, 'items'>): boolean {
  return (s.items?.length ?? 0) > 0
}

// What to ask the user to check when a low-confidence suggestion opens the
// edit card. `dateUncertain` is the server's own reason for the downgrade
// (see coerceSuggestion) — deriving it here from category + startAt can't
// work, because a backwards-resolved date arrives WITH a startAt and a model
// that was merely unsure about the category arrives with a perfectly good one.
export function lowConfidenceHint(
  s: Pick<AssistSuggestion, 'dateUncertain' | 'startAt'>,
): string {
  if (s.dateUncertain) {
    return s.startAt
      ? 'Not sure this landed on the right date — check when it happens.'
      : "Couldn't pin down a date for that one — set when it happens."
  }
  return 'Not fully sure on this one — check the category before saving.'
}

// The subset of a suggestion the edit card can change. Comparing it to the
// original picks the feedback verdict when the user saves after "Change".
export interface EditedFields {
  category: AssistCategory
  title: string
  notes: string | null
  dueDate: string | null
  startAt: string | null
  mood: number | null
  items: AssistFoodItem[] | null
}

function sameItems(a: AssistFoodItem[] | null, b: AssistFoodItem[] | null): boolean {
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false
  if (!a || !b) return true
  return a.every(
    (item, i) =>
      item.name === b[i]!.name &&
      item.grams === b[i]!.grams &&
      item.kcal === b[i]!.kcal &&
      item.proteinG === b[i]!.proteinG &&
      item.carbsG === b[i]!.carbsG &&
      item.fatG === b[i]!.fatG,
  )
}

export function editVerdict(original: AssistSuggestion, final: EditedFields): 'accepted' | 'edited' {
  const changed =
    original.category !== final.category ||
    original.title.trim() !== final.title.trim() ||
    (original.notes ?? null) !== (final.notes ?? null) ||
    (original.dueDate ?? null) !== (final.dueDate ?? null) ||
    (original.startAt ?? null) !== (final.startAt ?? null) ||
    (original.mood ?? null) !== (final.mood ?? null) ||
    !sameItems(original.items ?? null, final.items)
  return changed ? 'edited' : 'accepted'
}
