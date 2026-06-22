import { CATEGORY_KEY, isCategory } from '@rallypoint/lists-shared'

// Pure helpers for the cross-list item move endpoint. Kept out of the route
// handler so the field-cleaning rules can be unit-tested in isolation (the
// route just wires repo reads to these decisions).

// Clean an item's `customFields` for the TARGET list. A moved item carries
// values keyed by the SOURCE list's field-def ids; any key that is not a
// live def id in the target is dropped (the value is meaningless there). The
// reserved system key `rp:category` is preserved ONLY when the target is a
// shopping list — on any other target it is dropped.
//
// `targetDefIds` is the set of live field-def ids in the target list.
// `targetIsShopping` gates the rp:category carry-over.
export function cleanCustomFieldsForTarget(
  customFields: Record<string, unknown>,
  targetDefIds: Set<string>,
  targetIsShopping: boolean,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(customFields)) {
    if (k === CATEGORY_KEY) {
      if (targetIsShopping && isCategory(v)) cleaned[k] = v
      continue
    }
    if (targetDefIds.has(k)) cleaned[k] = v
  }
  return cleaned
}

// Resolve the item's `statusId` against the TARGET list. The id only has
// meaning inside its own list, so on move it is cleared unless it matches a
// live status of the target. The legacy `status` category text is left
// untouched (it is list-type-agnostic and still drives the completed mirror).
//
// Returns the statusId to persist (the original id when valid in the target,
// otherwise null).
export function resolveStatusIdForTarget(
  statusId: string | null,
  targetLiveStatusIds: Set<string>,
): string | null {
  if (statusId !== null && targetLiveStatusIds.has(statusId)) return statusId
  return null
}
