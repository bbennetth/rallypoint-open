// Pure decision helpers for the auto-saving task editor (TaskDetail) and the
// quick-add form. No React, no timers, no globals — unit-testable in isolation.

import { dateInputToInstant, instantToDateInput } from './planner-helpers.js'

// The saved baseline the editor diffs against. `dueInput` is the YYYY-MM-DD
// date-input representation (what the form edits), not the stored instant.
export interface TaskEditState {
  title: string
  priority: string | null
  dueInput: string
}

export interface TaskEditPatch {
  title?: string
  priority?: string | null
  dueDate?: string | null
}

// Baseline state for a task as loaded into the editor.
export function taskEditState(task: { title: string; priority: string | null; dueDate: string | null }): TaskEditState {
  return { title: task.title, priority: task.priority, dueInput: instantToDateInput(task.dueDate) }
}

// The sparse PATCH that moves `saved` to `draft`, or null when there is
// nothing (valid) to save. Field rules:
//   • title — trimmed; an empty/whitespace draft title is NOT saved (a task
//     must keep a title), so it never appears in the patch.
//   • priority — written verbatim, null means "no priority".
//   • dueDate — the draft's date-input value converted to a local-midnight
//     instant; '' clears to null.
export function buildTaskPatch(saved: TaskEditState, draft: TaskEditState): TaskEditPatch | null {
  const patch: TaskEditPatch = {}
  const title = draft.title.trim()
  if (title !== '' && title !== saved.title) patch.title = title
  if (draft.priority !== saved.priority) patch.priority = draft.priority
  if (draft.dueInput !== saved.dueInput) patch.dueDate = dateInputToInstant(draft.dueInput)
  return Object.keys(patch).length > 0 ? patch : null
}

// Apply a successful patch back onto the saved baseline so the next diff
// compares against what the server now has.
export function applyPatchToState(saved: TaskEditState, patch: TaskEditPatch): TaskEditState {
  return {
    title: patch.title !== undefined ? patch.title : saved.title,
    priority: patch.priority !== undefined ? patch.priority : saved.priority,
    dueInput: patch.dueDate !== undefined ? instantToDateInput(patch.dueDate) : saved.dueInput,
  }
}

// localStorage key remembering the last list a quick-add task was filed to.
export const LAST_TASK_LIST_KEY = 'rallypt-planner-last-task-list'

// The list the quick-add form should preselect: the remembered list when it
// still exists, else the first list, else '' (no lists).
export function pickDefaultList(lists: { id: string }[], storedId: string | null): string {
  if (storedId && lists.some((l) => l.id === storedId)) return storedId
  return lists[0]?.id ?? ''
}
