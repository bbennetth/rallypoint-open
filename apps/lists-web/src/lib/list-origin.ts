// List-origin partitioning for My Lists. Planner creates and owns the
// lists in its personal group (task lists plus the `shopping`/`notes`
// utility lists); they're real lists rows but not something a Lists user
// authored here, so My Lists presents them in their own read-only
// "Managed by Planner" section (#531 separation).

import type { ListType } from '@rallypoint/lists-shared'

export function isPlannerManaged(listType: ListType): boolean {
  return listType === 'shopping' || listType === 'notes'
}

// `scopeIsPlanner` marks the whole scope as Planner-provisioned (group
// origin === 'planner') — every list in it is Planner-managed, not just
// the utility list types.
export function partitionByOrigin<T extends { list_type: ListType }>(
  lists: readonly T[],
  scopeIsPlanner = false,
): { own: T[]; plannerManaged: T[] } {
  if (scopeIsPlanner) return { own: [], plannerManaged: [...lists] }
  const own: T[] = []
  const plannerManaged: T[] = []
  for (const list of lists) {
    if (isPlannerManaged(list.list_type)) plannerManaged.push(list)
    else own.push(list)
  }
  return { own, plannerManaged }
}
