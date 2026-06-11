// Pure task-type logic for Rallypoint Lists, ported from
// festival-planner's src/shared/taskLogic.ts + taskListLogic.ts. Lives
// here (not in validators.ts) so the behavioural rules are testable on
// their own; the status/priority enums + field schemas stay in
// validators.ts to avoid a circular import (this module depends on the
// Visibility type from there). Both are re-exported from the barrel.

import type { Visibility } from './validators.js'
import type { TaskStatus } from './validators.js'

export type { TaskStatus, TaskPriority } from './validators.js'

// Status cycle driven by clicking a task card (festival-planner
// Tasks.tsx:220-228): todo → in_progress → done → todo.
export const STATUS_CYCLE: Record<TaskStatus, TaskStatus> = {
  todo: 'in_progress',
  in_progress: 'done',
  done: 'todo',
}

export function nextStatus(status: TaskStatus): TaskStatus {
  return STATUS_CYCLE[status]
}

// The generic `completed` flag mirrors task status: a task is "completed"
// exactly when it is done. The API repo and the kanban UI both route
// through this so the mirror rule lives in one place.
export function statusMirrorsCompleted(status: TaskStatus): { completed: boolean } {
  return { completed: status === 'done' }
}

// Ownership-on-move (festival-planner taskListLogic.ts:164-170). When a
// task moves to a private list, ownership (created_by) transfers to that
// list's creator so the task lands in the owner's personal board; moving
// to an `all`/`custom` (shared) list leaves ownership unchanged. A null/
// missing target (deleted list) is a no-op. Returns the new owner id, or
// null to mean "leave created_by as-is".
export function ownerTransferForMove(
  targetList: { visibility: Visibility; createdBy: string } | null | undefined,
): string | null {
  if (!targetList) return null
  if (targetList.visibility !== 'private') return null
  return targetList.createdBy
}
