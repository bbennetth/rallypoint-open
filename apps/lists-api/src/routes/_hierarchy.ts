import { validateParentAssignment } from '@rallypoint/lists-shared'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// Sentinel id for a not-yet-created item on the create path. Bounded
// item-id validation (`lit_…`) guarantees no real id collides with it.
const NEW_ITEM = '__new__'

// Validate a proposed parent assignment for an item within a list and
// throw a 400 with the precise reason on failure. Builds the list's
// parent map from its live items, so a parentId from ANOTHER list is
// simply absent → 'missing' (cross-list parents are rejected for free).
// `itemId` is null on the create path (the item isn't persisted yet).
export async function assertValidParent(
  c: Context<HonoApp>,
  listId: string,
  itemId: string | null,
  parentId: string,
): Promise<void> {
  const items = await c.var.repos.listItems.listForList(listId)
  const parentOf = new Map(items.map((i) => [i.id, i.parentId]))
  const result = validateParentAssignment(parentOf, itemId ?? NEW_ITEM, parentId)
  if (result === 'ok') return

  const message =
    result === 'self'
      ? 'An item cannot be its own parent.'
      : result === 'missing'
        ? 'Parent item not found in this list.'
        : result === 'cycle'
          ? 'That parent would create a cycle.'
          : 'Sub-item nesting is too deep.'
  throw errors.validation({ issues: [{ code: 'custom', path: ['parentId'], message }] })
}
