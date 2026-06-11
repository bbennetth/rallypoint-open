import { SYSTEM_MANAGED_LIST_TYPES } from '@rallypoint/lists-shared'

// Planner-side deletability guard for personal lists.
//
// System-managed list types (shopping, notes) are provisioned automatically
// by the Planner BFF and must not be deletable through any surface. Uses the
// central SYSTEM_MANAGED_LIST_TYPES definition from lists-shared so this
// guard stays in sync if new managed types are added in the future.
export function canDeletePersonalList(list: { listType: string }): boolean {
  return !SYSTEM_MANAGED_LIST_TYPES.has(list.listType as 'shopping' | 'notes')
}
