// Pure decision helpers for the auto-saving shopping-item editor
// (ShoppingItemDetail). No React, no timers, no globals — unit-testable in
// isolation. Mirrors task-edit.ts, which serves the same role for TaskDetail.

import { CATEGORY_KEY, type ShoppingCategory, type ShoppingItemDto } from './api.js'
import { itemCategory, itemQuantity, normalizeQuantityInput } from './shopping-helpers.js'

// The editable shape of a shopping item. `quantity` is the raw text in the
// input, normalized only on the way out (see buildShoppingPatch).
export interface ShoppingEditState {
  title: string
  category: ShoppingCategory
  quantity: string
}

export interface ShoppingEditPatch {
  title?: string
  customFields?: Record<string, unknown>
}

// Baseline state for an item as loaded into the editor.
export function shoppingEditState(
  item: ShoppingItemDto,
  quantityFieldId: string | null,
): ShoppingEditState {
  return {
    title: item.title,
    category: itemCategory(item),
    quantity: itemQuantity(item, quantityFieldId) ?? '',
  }
}

// The full customFields map for a shopping item.
//
// Every key this app owns is always present, never just the changed one.
// lists-api merges customFields server-side, but the offline cache's
// optimistic merge (mergeItemPatch) replaces the whole customFields object —
// so sending a single key would visibly wipe its siblings (change the
// category and the quantity chip vanishes) until the next refetch. Keys this
// app doesn't own are deliberately not echoed, so a def deleted from the
// Lists UI can't be resurrected into a server validation error.
export function shoppingCustomFields(
  category: ShoppingCategory,
  quantity: string | null,
  quantityFieldId: string | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = { [CATEGORY_KEY]: category }
  // A null value clears the field server-side; omitting the key entirely
  // would instead leave a stale value behind on the merge.
  if (quantityFieldId) fields[quantityFieldId] = quantity
  return fields
}

// The sparse PATCH that moves `saved` to `draft`, or null when there is
// nothing (valid) to save. Field rules:
//   • title — trimmed; an empty/whitespace draft title is NOT saved (an item
//     must keep a title), so it never appears in the patch.
//   • category / quantity — either one changing re-emits the whole
//     customFields map (see shoppingCustomFields). Quantity is compared
//     normalized, so trailing whitespace alone is not a change.
export function buildShoppingPatch(
  saved: ShoppingEditState,
  draft: ShoppingEditState,
  quantityFieldId: string | null,
): ShoppingEditPatch | null {
  const patch: ShoppingEditPatch = {}
  const title = draft.title.trim()
  if (title !== '' && title !== saved.title) patch.title = title
  const nextQuantity = normalizeQuantityInput(draft.quantity)
  if (
    draft.category !== saved.category ||
    nextQuantity !== normalizeQuantityInput(saved.quantity)
  ) {
    patch.customFields = shoppingCustomFields(draft.category, nextQuantity, quantityFieldId)
  }
  return Object.keys(patch).length > 0 ? patch : null
}

// The baseline to diff against after a successful save of `draft`: what the
// server now holds. An empty draft title was never sent, so the saved title
// stands; the quantity settles to its normalized form.
export function savedShoppingState(
  saved: ShoppingEditState,
  draft: ShoppingEditState,
): ShoppingEditState {
  const title = draft.title.trim()
  return {
    title: title === '' ? saved.title : title,
    category: draft.category,
    quantity: normalizeQuantityInput(draft.quantity) ?? '',
  }
}
