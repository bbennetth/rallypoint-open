import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  addShoppingItemByTitle,
  groupItemsByCategory,
  isShoppingCategory,
  itemCategory,
} from './shopping-helpers.js'
import type { ShoppingItemDto } from './api.js'
import { CATEGORY_KEY } from './api.js'

// --- test helpers -------------------------------------------------------

function makeItem(
  id: string,
  title: string,
  category?: string,
  completed = false,
): ShoppingItemDto {
  return {
    id,
    listId: 'lst_test',
    title,
    notes: null,
    completed,
    status: null,
    priority: null,
    dueDate: null,
    position: 0,
    seriesId: null,
    customFields: category !== undefined ? { [CATEGORY_KEY]: category } : {},
    createdAt: new Date().toISOString(),
  }
}

// --- isShoppingCategory() -----------------------------------------------
describe('isShoppingCategory()', () => {
  it('accepts all valid categories', () => {
    const valid = [
      'produce', 'dairy', 'meat-seafood', 'bakery', 'pantry',
      'frozen', 'beverages', 'household', 'personal-care', 'electronics', 'other',
    ]
    for (const c of valid) {
      expect(isShoppingCategory(c)).toBe(true)
    }
  })

  it('rejects unknown strings', () => {
    expect(isShoppingCategory('fruit')).toBe(false)
    expect(isShoppingCategory('')).toBe(false)
    expect(isShoppingCategory(null)).toBe(false)
    expect(isShoppingCategory(42)).toBe(false)
    expect(isShoppingCategory(undefined)).toBe(false)
  })
})

// --- itemCategory() -----------------------------------------------------
describe('itemCategory()', () => {
  it('returns the stored category from customFields', () => {
    const item = makeItem('1', 'Milk', 'dairy')
    expect(itemCategory(item)).toBe('dairy')
  })

  it('falls back to "other" when customFields has no rp:category', () => {
    const item = makeItem('2', 'Milk') // no category
    expect(itemCategory(item)).toBe('other')
  })

  it('falls back to "other" when rp:category is an unknown value', () => {
    const item = makeItem('3', 'Milk', 'fruit') // invalid category
    expect(itemCategory(item)).toBe('other')
  })

  it('falls back to "other" when rp:category is null', () => {
    const item: ShoppingItemDto = { ...makeItem('4', 'Milk'), customFields: { [CATEGORY_KEY]: null } }
    expect(itemCategory(item)).toBe('other')
  })
})

// --- groupItemsByCategory() ---------------------------------------------
describe('groupItemsByCategory()', () => {
  it('returns empty array for empty input', () => {
    expect(groupItemsByCategory([])).toEqual([])
  })

  it('groups items by category', () => {
    const items = [
      makeItem('a', 'Milk', 'dairy'),
      makeItem('b', 'Cheese', 'dairy'),
      makeItem('c', 'Apples', 'produce'),
    ]
    const groups = groupItemsByCategory(items)
    expect(groups.length).toBe(2)
    const catNames = groups.map((g) => g.category)
    // produce comes before dairy in SHOPPING_CATEGORY_ORDER
    expect(catNames[0]).toBe('produce')
    expect(catNames[1]).toBe('dairy')
    expect(groups[1].items.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('places items with no category into "other"', () => {
    const items = [
      makeItem('x', 'Unknown item'), // no category
      makeItem('y', 'Another unknown'),
    ]
    const groups = groupItemsByCategory(items)
    expect(groups.length).toBe(1)
    expect(groups[0].category).toBe('other')
    expect(groups[0].items.length).toBe(2)
  })

  it('preserves server-side item order within each category group', () => {
    const items = [
      makeItem('first', 'Bread', 'bakery'),
      makeItem('second', 'Bagel', 'bakery'),
      makeItem('third', 'Croissant', 'bakery'),
    ]
    const groups = groupItemsByCategory(items)
    expect(groups.length).toBe(1)
    expect(groups[0].items.map((i) => i.id)).toEqual(['first', 'second', 'third'])
  })

  it('respects SHOPPING_CATEGORY_ORDER for section ordering', () => {
    const items = [
      makeItem('h', 'Paper towels', 'household'),
      makeItem('p', 'Carrots', 'produce'),
      makeItem('b', 'Juice', 'beverages'),
      makeItem('f', 'Ice cream', 'frozen'),
    ]
    const groups = groupItemsByCategory(items)
    const order = groups.map((g) => g.category)
    // Expected order per SHOPPING_CATEGORY_ORDER: produce < frozen < beverages < household
    expect(order.indexOf('produce')).toBeLessThan(order.indexOf('frozen'))
    expect(order.indexOf('frozen')).toBeLessThan(order.indexOf('beverages'))
    expect(order.indexOf('beverages')).toBeLessThan(order.indexOf('household'))
  })

  it('omits empty categories', () => {
    const items = [makeItem('x', 'Salmon', 'meat-seafood')]
    const groups = groupItemsByCategory(items)
    expect(groups.length).toBe(1)
    expect(groups[0].category).toBe('meat-seafood')
  })

  it('does not mutate the input array', () => {
    const items = [makeItem('a', 'Milk', 'dairy'), makeItem('b', 'Eggs', 'dairy')]
    const copy = [...items]
    groupItemsByCategory(items)
    expect(items).toEqual(copy)
  })
})

// --- addShoppingItemByTitle() -------------------------------------------
// Mock the two api functions at the module boundary (pure API-layer logic —
// no D1; mocking fetch/api functions here is correct per project test rules).
vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>()
  return {
    ...actual,
    getShoppingList: vi.fn(),
    createShoppingItem: vi.fn(),
  }
})

describe('addShoppingItemByTitle()', () => {
  const mockGetShoppingList = vi.fn()
  const mockCreateShoppingItem = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
    const api = await import('./api.js')
    mockGetShoppingList.mockImplementation(api.getShoppingList as unknown as typeof mockGetShoppingList)
    mockCreateShoppingItem.mockImplementation(api.createShoppingItem as unknown as typeof mockCreateShoppingItem)
    // Reset the vi.fn() spies on the mocked module
    ;(api.getShoppingList as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'lst_shop', name: 'Shopping' })
    ;(api.createShoppingItem as ReturnType<typeof vi.fn>).mockResolvedValue(makeItem('itm_1', 'Milk'))
  })

  it('rejects with an error for an empty title', async () => {
    await expect(addShoppingItemByTitle('')).rejects.toThrow('Title must not be empty')
  })

  it('rejects with an error for a whitespace-only title', async () => {
    await expect(addShoppingItemByTitle('   ')).rejects.toThrow('Title must not be empty')
  })

  it('calls getShoppingList then createShoppingItem with resolved id + trimmed title', async () => {
    const api = await import('./api.js')
    const result = await addShoppingItemByTitle('  Milk  ')
    expect(api.getShoppingList).toHaveBeenCalledOnce()
    expect(api.createShoppingItem).toHaveBeenCalledWith('lst_shop', 'Milk')
    expect(result.id).toBe('itm_1')
  })

  it('does not call createShoppingItem if getShoppingList throws', async () => {
    const api = await import('./api.js')
    ;(api.getShoppingList as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'))
    await expect(addShoppingItemByTitle('Milk')).rejects.toThrow('network error')
    expect(api.createShoppingItem).not.toHaveBeenCalled()
  })
})
