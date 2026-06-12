// Pure custom-status logic for Rallypoint Lists (RPL v1.0.0 slice 1).
// Statuses live per-list in `list_statuses`; this module holds the
// framework-agnostic rules both apps/lists-api and apps/lists-web agree
// on: the seeded defaults and the category-driven helpers (completion
// mirror, kanban grouping, legacy-text resolution).

import type { StatusCategory } from './validators.js'

export interface StatusSeed {
  name: string
  category: StatusCategory
  color: string
}

// The statuses seeded into a list the first time its statuses are read
// (lazy seed — no migration backfill, since D1 can't mint ULIDs in pure
// SQL). Array order is the seeded `position`. These reproduce the legacy
// hard-coded todo → in_progress → done board so existing task lists look
// unchanged after the migration.
export const DEFAULT_STATUS_SEEDS: readonly StatusSeed[] = [
  { name: 'To do', category: 'todo', color: 'slate' },
  { name: 'In progress', category: 'in_progress', color: 'amber' },
  { name: 'Done', category: 'done', color: 'green' },
] as const

// The minimal status shape the pure helpers need. The repo records carry
// more, but resolution/grouping only ever key off these three.
export interface StatusLike {
  id: string
  category: StatusCategory
  position: number
}

export function isDoneCategory(category: StatusCategory): boolean {
  return category === 'done'
}

// done ⟺ completed mirror, keyed off a status's category. A list item is
// "completed" exactly when its status is in the done category. Replaces
// the legacy task-status mirror (which keyed off the literal 'done'
// value) now that the done state is a renameable per-list status.
export function categoryMirrorsCompleted(category: StatusCategory): { completed: boolean } {
  return { completed: isDoneCategory(category) }
}

// Resolve a category to the list's representative status of that category
// — the lowest-position match. Used to (a) back-fill an item's status_id
// from its legacy `status` text, and (b) pick the target status when a
// PR-merge / release closes an item ("first done-category status").
// Returns null when the list has no status in that category.
export function defaultStatusForCategory<T extends StatusLike>(
  statuses: readonly T[],
  category: StatusCategory,
): T | null {
  let best: T | null = null
  for (const s of statuses) {
    if (s.category !== category) continue
    if (best === null || s.position < best.position) best = s
  }
  return best
}

// The status an item should move to when it is "completed" (check-off,
// PR merge, release). Convenience wrapper over defaultStatusForCategory
// for the done category.
export function firstDoneStatus<T extends StatusLike>(statuses: readonly T[]): T | null {
  return defaultStatusForCategory(statuses, 'done')
}

// True when deleting `statusId` would strip the list of its last
// done-category status — the one delete the route must reject so
// "complete" stays expressible.
export function isLastDoneStatus(statuses: readonly StatusLike[], statusId: string): boolean {
  const target = statuses.find((s) => s.id === statusId)
  if (!target || target.category !== 'done') return false
  return statuses.filter((s) => s.category === 'done').length <= 1
}
