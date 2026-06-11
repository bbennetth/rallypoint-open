// Pure helpers for the Shopping page. No React, no I/O — unit-testable
// in isolation.

import {
  CATEGORY_KEY,
  SHOPPING_CATEGORY_ORDER,
  createShoppingItem,
  getShoppingList,
  type ShoppingCategory,
  type ShoppingItemDto,
} from './api.js'

// A section of items sharing one category, ordered by SHOPPING_CATEGORY_ORDER.
export interface CategoryGroup {
  category: ShoppingCategory
  items: ShoppingItemDto[]
}

// Type-guard: is the value a known shopping category?
const CATEGORY_SET = new Set<string>(SHOPPING_CATEGORY_ORDER)
export function isShoppingCategory(s: unknown): s is ShoppingCategory {
  return typeof s === 'string' && CATEGORY_SET.has(s)
}

// Extract the category from an item's customFields (the reserved `rp:category`
// key set server-side). Falls back to 'other' for items without a category
// (e.g. items created before this feature shipped, or on non-shopping lists).
export function itemCategory(item: ShoppingItemDto): ShoppingCategory {
  const v = item.customFields[CATEGORY_KEY]
  return isShoppingCategory(v) ? v : 'other'
}

// Resolve the caller's single shopping list (auto-provisioned on first call)
// then create an item with the given title. Rejects with an error if `title`
// is empty / whitespace-only so callers don't need to guard separately.
// The server auto-categorizes the item; no category arg is needed.
export async function addShoppingItemByTitle(title: string): Promise<ShoppingItemDto> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error('Title must not be empty')
  const list = await getShoppingList()
  return createShoppingItem(list.id, trimmed)
}

// Ids of all checked-off items, in original order. Pure — used by the
// "Clear checked" action to decide what to delete.
export function completedItemIds(items: ShoppingItemDto[]): string[] {
  return items.filter((i) => i.completed).map((i) => i.id)
}

// Group a flat item list by category, in SHOPPING_CATEGORY_ORDER order.
// Empty categories are omitted. Within each group, items are in their
// original server order (position-sorted). Pure — does not mutate input.
export function groupItemsByCategory(items: ShoppingItemDto[]): CategoryGroup[] {
  const buckets = new Map<ShoppingCategory, ShoppingItemDto[]>()
  for (const item of items) {
    const cat = itemCategory(item)
    if (!buckets.has(cat)) buckets.set(cat, [])
    buckets.get(cat)!.push(item)
  }
  const result: CategoryGroup[] = []
  for (const cat of SHOPPING_CATEGORY_ORDER) {
    const group = buckets.get(cat)
    if (group && group.length > 0) result.push({ category: cat, items: group })
  }
  return result
}
