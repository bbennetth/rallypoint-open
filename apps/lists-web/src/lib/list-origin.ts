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

// Resolve the ListDetailPage readOnly flag for a `list_group`-scoped
// list. `groupsLookup` is `null` when the /groups lookup threw (network
// error, etc.) — fail CLOSED in that case (#675): a lookup failure must
// not silently render mutating controls the server would 403 on anyway.
// Non-`list_group` scopes (personal/direct lists) are never Planner-
// managed via this path, so they're always writable here.
export function resolvePlannerReadOnly(
  scopeType: string,
  scopeId: string,
  groupsLookup: { items: { id: string; origin: string | null }[] } | null,
): boolean {
  if (scopeType !== 'list_group') return false
  if (groupsLookup === null) return true
  return groupsLookup.items.find((g) => g.id === scopeId)?.origin === 'planner'
}
