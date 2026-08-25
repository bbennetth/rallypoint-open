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

// Max length of a quantity value. Quantities are free-form ("2", "4 bags",
// "3 cs") so there is nothing to parse — only a cap so a stray paste can't
// blow out the row's chip.
export const MAX_QUANTITY_LEN = 24

// An item's quantity for display, or null when it has none. `fieldId` is the
// shopping list's `quantity` custom-field def id (custom_fields is keyed by
// def id, not by name); null when the BFF couldn't resolve the def, in which
// case no item has a readable quantity. Numeric values are tolerated — a def
// retyped to `number` from the Lists UI shouldn't blank every chip.
export function itemQuantity(item: ShoppingItemDto, fieldId: string | null): string | null {
  if (!fieldId) return null
  const v = item.customFields[fieldId]
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

// The value to persist for a typed quantity: trimmed and capped, or null to
// clear the field (lists-api treats a null custom-field value as "unset").
export function normalizeQuantityInput(raw: string): string | null {
  const trimmed = raw.trim().slice(0, MAX_QUANTITY_LEN)
  return trimmed === '' ? null : trimmed
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

// Max length of a single item title, matching the quick-note title cap.
const MAX_ITEM_TITLE = 200

// Max items per bulk add — bounds the sequential create loop (each item is
// an outbox enqueue + cache rewrite) so an accidental huge paste can't run
// away. The form refuses to submit above this rather than silently dropping.
export const MAX_BULK_SHOPPING_ITEMS = 100

// Split bulk-add text into item titles: one per non-empty line, trimmed,
// truncated to MAX_ITEM_TITLE. Duplicate lines are kept — repeating a line
// is treated as intentional, not a paste error. Pure.
export function parseShoppingLines(raw: string): string[] {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim().slice(0, MAX_ITEM_TITLE))
    .filter((line) => line !== '')
}

// Outcome of a bulk add. On a mid-loop create failure the loop stops:
// `created` holds what landed, `remaining` the titles never attempted
// (including the failed one, so re-submitting `remaining` can't duplicate),
// and `error` the failure that stopped it. Full success: remaining=[] and
// no error.
export interface BulkAddResult {
  created: ShoppingItemDto[]
  remaining: string[]
  error?: unknown
}

// Bulk variant of addShoppingItemByTitle: resolves the shopping list once,
// then creates one item per title sequentially so outbox/cache order matches
// the order the user typed. Titles are assumed pre-parsed (parseShoppingLines);
// rejects if the array is empty or oversized. Rethrows a getShoppingList
// failure (nothing created yet, so a whole-batch retry is safe); a mid-loop
// create failure is reported via the result instead so callers can offer a
// duplicate-safe retry of just the remainder.
export async function addShoppingItemsByTitles(titles: string[]): Promise<BulkAddResult> {
  if (titles.length === 0) throw new Error('No items to add')
  if (titles.length > MAX_BULK_SHOPPING_ITEMS)
    throw new Error(`Too many items — max ${MAX_BULK_SHOPPING_ITEMS} per add`)
  const list = await getShoppingList()
  const created: ShoppingItemDto[] = []
  for (let i = 0; i < titles.length; i++) {
    try {
      created.push(await createShoppingItem(list.id, titles[i]!))
    } catch (error) {
      return { created, remaining: titles.slice(i), error }
    }
  }
  return { created, remaining: [] }
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
